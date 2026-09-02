#!/usr/bin/env bash
# S3 + CloudFront に静的サイトを公開する。
# 必要: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STACK="${STACK:-traffic-a-kun-xr}"
DOMAIN="${DOMAIN:-traffic.a-kun-xr.com}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_REGION="$REGION"

need() { command -v "$1" >/dev/null || { echo "need $1" >&2; exit 1; }; }
need aws
need npm
need python3

stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

cert_for_domain() {
  aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn" \
    --output text | awk '{print $1}'
}

echo "==> ACM 証明書 ($DOMAIN)"
CERT_ARN="$(cert_for_domain || true)"
if [[ -z "${CERT_ARN:-}" || "$CERT_ARN" == "None" ]]; then
  CERT_ARN="$(aws acm request-certificate \
    --domain-name "$DOMAIN" \
    --validation-method DNS \
    --options CertificateTransparencyLoggingPreference=ENABLED \
    --query CertificateArn --output text)"
  echo "requested $CERT_ARN"
  # DNS 検証レコードが出るまで少し待つ
  for _ in 1 2 3 4 5 6; do
    sleep 3
    RECORD="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" \
      --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)"
    NAME="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('Name') or '')" "$RECORD")"
    [[ -n "$NAME" ]] && break
  done
else
  echo "using $CERT_ARN"
fi

CERT_STATUS="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)"
RECORD="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)"
VAL_NAME="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('Name') or '')" "$RECORD")"
VAL_VALUE="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('Value') or '')" "$RECORD")"

echo "certificate status: $CERT_STATUS"
echo "DNS (Cloudflare, proxy オフ / DNS only):"
echo "  CNAME  $VAL_NAME  ->  $VAL_VALUE"

CFN_CERT=""
if [[ "$CERT_STATUS" == "ISSUED" ]]; then
  CFN_CERT="$CERT_ARN"
  echo "証明書は発行済み。CloudFront に $DOMAIN を付けます。"
else
  echo "証明書待ち。まずは CloudFront 既定ドメインで公開します。"
fi

echo "==> CloudFormation $STACK"
PARAMS="DomainName=$DOMAIN"
if [[ -n "$CFN_CERT" ]]; then
  PARAMS="$PARAMS CertificateArn=$CFN_CERT"
fi
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/static-site.yml \
  --parameter-overrides $PARAMS \
  --no-fail-on-empty-changeset

BUCKET="$(stack_output BucketName)"
DIST_ID="$(stack_output DistributionId)"
DIST_DNS="$(stack_output DistributionDomainName)"

echo "==> build"
export VITE_BASE="${VITE_BASE:-/}"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

echo "==> sync s3://$BUCKET"
aws s3 sync dist/ "s3://$BUCKET" --delete \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "public,max-age=60,must-revalidate" \
  --content-type "text/html"
if [[ -f dist/data/graph.json ]]; then
  aws s3 cp dist/data/graph.json "s3://$BUCKET/data/graph.json" \
    --cache-control "public,max-age=60,must-revalidate" \
    --content-type "application/json"
fi

echo "==> invalidate CloudFront $DIST_ID"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

upsert_cname() {
  local name="$1" content="$2"
  [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "$name" || -z "$content" ]] && return 1
  python3 - "$name" "$content" <<'PY'
import json, os, sys, urllib.request

token = os.environ["CLOUDFLARE_API_TOKEN"]
name, content = sys.argv[1], sys.argv[2]
zone_name = os.environ.get("CLOUDFLARE_ZONE", "a-kun-xr.com")

def cf(method, path, body=None):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)

zones = cf("GET", f"/zones?name={zone_name}")["result"]
if not zones:
    raise SystemExit(f"Cloudflare zone not found: {zone_name}")
zid = zones[0]["id"]
existing = cf("GET", f"/zones/{zid}/dns_records?type=CNAME&name={name}")["result"]
payload = {"type": "CNAME", "name": name, "content": content, "proxied": False, "ttl": 1}
if existing:
    rec = cf("PUT", f"/zones/{zid}/dns_records/{existing[0]['id']}", payload)
else:
    rec = cf("POST", f"/zones/{zid}/dns_records", payload)
if not rec.get("success"):
    raise SystemExit(rec)
print(f"Cloudflare CNAME {name} -> {content}")
PY
}

echo
echo "公開 URL (CloudFront): https://$DIST_DNS"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "==> Cloudflare DNS"
  upsert_cname "$VAL_NAME" "$VAL_VALUE" || true
  upsert_cname "$DOMAIN" "$DIST_DNS" || true
fi
if [[ "$CERT_STATUS" == "ISSUED" ]]; then
  echo "カスタムドメイン: https://$DOMAIN"
  echo "Cloudflare に次を追加 (DNS only / プロキシオフ):"
  echo "  CNAME  traffic  ->  $DIST_DNS"
else
  echo "カスタムドメインは証明書発行後です。Cloudflare に検証 CNAME を追加してから再実行:"
  echo "  CNAME  $VAL_NAME  ->  $VAL_VALUE"
  echo "発行後の再実行で https://$DOMAIN が有効になります。あわせて:"
  echo "  CNAME  traffic  ->  $DIST_DNS"
fi
