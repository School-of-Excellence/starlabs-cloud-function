#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Point a Firebase project's OpenVidu Cloud Functions at a media stack (dev or
# prod, AWS and/or OCI) and deploy them.
#
# What it does:
#   1. AWS:  pulls LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the
#      stack's AWS Secrets Manager entry, and derives MASTER_INSTANCE_ID /
#      MEDIA_ASG_NAME from EC2 / Auto Scaling.
#      OCI:  pulls LIVEKIT_*_OCI from that stack's OCI Vault, the S3 recording
#      key pair from the stack's Terraform state, the API-signing credentials
#      from ~/.oci/config, and the master / instance-pool OCIDs from the OCI API.
#      Either way no secret is ever hand-copied.
#   2. Writes those Firebase secrets for the target project.
#   3. Temporarily flips functions/package.json "main" -> index.openvidu-deploy.js
#      (so the CLI only sees the OpenVidu exports), deploys with an explicit
#      --only list (never deletes other functions), then restores "main" ->
#      index.emulator.js via an EXIT trap.
#
# Usage:
#   bash scripts/set-secrets-and-deploy.sh dev            # AWS only (default, unchanged)
#   bash scripts/set-secrets-and-deploy.sh dev secrets    # secrets only
#   bash scripts/set-secrets-and-deploy.sh dev deploy     # deploy only
#
#   PROVIDER=oci  bash scripts/set-secrets-and-deploy.sh prod
#   PROVIDER=both bash scripts/set-secrets-and-deploy.sh prod   # <- prod first run
#
# PROVIDER defaults to "aws" so every existing invocation behaves exactly as
# before. Use "both" for the prod bring-up: it redeploys CheckMasternodeStatus,
# which gained the activeprovider gate and must be refreshed alongside the OCI
# functions.
#
# Optional (prod cutover — set the new-account IAM keys for that project):
#   SET_AWS_ACCESS_KEY='AKIA...' SET_AWS_SECRET='...' bash scripts/set-secrets-and-deploy.sh prod
#
# Env:
#   PROVIDER     aws | oci | both        (default aws)
#   OCI_TF_DIR   Terraform dir for the OCI stacks (default below)
#
# Requires: firebase CLI, python3; aws CLI for the AWS path; oci CLI + terraform
# for the OCI path.
# ---------------------------------------------------------------------------
set -euo pipefail

ENVN="${1:-}"
MODE="${2:-all}"   # all | secrets | deploy
PROVIDER="${PROVIDER:-aws}"   # aws | oci | both
case "$ENVN" in dev|prod) ;; *) echo "Usage: [PROVIDER=aws|oci|both] bash $0 <dev|prod> [all|secrets|deploy]"; exit 1;; esac
case "$MODE" in all|secrets|deploy) ;; *) echo "mode must be all|secrets|deploy"; exit 1;; esac
case "$PROVIDER" in aws|oci|both) ;; *) echo "PROVIDER must be aws|oci|both"; exit 1;; esac

if [[ "$ENVN" == "prod" ]]; then PROJECT="fir-sample-aae4a"; else PROJECT="starlabs-test"; fi
R="ap-south-1"
STACK="OpenViduElastic-${ENVN}"
SECRET_NAME="openvidu-elastic-${R}-${STACK}"

OCI_TF_DIR="${OCI_TF_DIR:-/Users/m1/Documents/Oracle Cloud/openvidu-oracle/pro/elastic}"
OCI_STACK="openvidu-elastic-${ENVN}"
if [[ "$ENVN" == "dev" ]]; then OCI_WS="default"; else OCI_WS="$ENVN"; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FUNCTIONS_DIR="$PROJECT_ROOT/functions"
PKG="$FUNCTIONS_DIR/package.json"

echo "=================================================================="
echo " env=$ENVN  firebase-project=$PROJECT  provider=$PROVIDER  mode=$MODE"
echo "=================================================================="

# ---- prod safety gate ----
if [[ "$ENVN" == "prod" && "${FORCE:-}" != "1" ]]; then
  read -r -p "About to target PRODUCTION ($PROJECT). Type PROD to continue: " ok
  [[ "$ok" == "PROD" ]] || { echo "aborted."; exit 1; }
fi

setsecret(){ printf '%s' "$2" | firebase functions:secrets:set "$1" --project "$PROJECT" --data-file - --force >/dev/null; echo "     set $1"; }

# =================== 1 + 2. SECRETS ===================
if [[ "$MODE" == "all" || "$MODE" == "secrets" ]]; then

  # ---------------------------- AWS ----------------------------
  if [[ "$PROVIDER" == "aws" || "$PROVIDER" == "both" ]]; then
    echo ">> [aws] Reading credentials from stack $STACK ..."
    SECRET_JSON="$(aws secretsmanager get-secret-value --region "$R" --secret-id "$SECRET_NAME" \
                    --query 'SecretString' --output text)" \
      || { echo "ERROR: cannot read $SECRET_NAME (is the stack deployed? is AWS CLI logged in?)"; exit 1; }

    getval(){ printf '%s' "$SECRET_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }
    LIVEKIT_URL="$(getval LIVEKIT_URL)"
    LIVEKIT_API_KEY="$(getval LIVEKIT_API_KEY)"
    LIVEKIT_API_SECRET="$(getval LIVEKIT_API_SECRET)"

    MASTER_INSTANCE_ID="$(aws ec2 describe-instances --region "$R" \
      --filters "Name=tag:Name,Values=*${STACK}*" "Name=tag:Name,Values=*Master*" \
                "Name=instance-state-name,Values=running,stopped" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text)"
    MEDIA_ASG_NAME="$(aws autoscaling describe-auto-scaling-groups --region "$R" \
      --query "AutoScalingGroups[?contains(AutoScalingGroupName,'${STACK}')].AutoScalingGroupName | [0]" \
      --output text)"

    for pair in "LIVEKIT_URL=$LIVEKIT_URL" "LIVEKIT_API_KEY=$LIVEKIT_API_KEY" \
                "LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET" "MASTER_INSTANCE_ID=$MASTER_INSTANCE_ID" \
                "MEDIA_ASG_NAME=$MEDIA_ASG_NAME"; do
      val="${pair#*=}"; [[ -n "$val" && "$val" != "None" ]] || { echo "ERROR: empty value for ${pair%%=*}"; exit 1; }
    done

    echo ">> [aws] Resolved (secret values masked):"
    echo "     LIVEKIT_URL        = $LIVEKIT_URL"
    echo "     LIVEKIT_API_KEY    = ${LIVEKIT_API_KEY:0:4}******"
    echo "     LIVEKIT_API_SECRET = ******"
    echo "     MASTER_INSTANCE_ID = $MASTER_INSTANCE_ID"
    echo "     MEDIA_ASG_NAME     = $MEDIA_ASG_NAME"

    echo ">> [aws] Writing Firebase secrets to $PROJECT ..."
    setsecret LIVEKIT_URL        "$LIVEKIT_URL"
    setsecret LIVEKIT_API_KEY    "$LIVEKIT_API_KEY"
    setsecret LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET"
    setsecret MASTER_INSTANCE_ID "$MASTER_INSTANCE_ID"
    setsecret MEDIA_ASG_NAME     "$MEDIA_ASG_NAME"

    # Optional: new-account IAM keys (typically only needed for prod cutover)
    if [[ -n "${SET_AWS_ACCESS_KEY:-}" && -n "${SET_AWS_SECRET:-}" ]]; then
      setsecret AWS_ACCESS_KEY "$SET_AWS_ACCESS_KEY"
      setsecret AWS_SECRET     "$SET_AWS_SECRET"
    else
      echo "     (AWS_ACCESS_KEY/AWS_SECRET left unchanged)"
    fi
  fi

  # ---------------------------- OCI ----------------------------
  if [[ "$PROVIDER" == "oci" || "$PROVIDER" == "both" ]]; then
    command -v oci >/dev/null       || { echo "ERROR: oci CLI not found"; exit 1; }
    command -v terraform >/dev/null || { echo "ERROR: terraform not found"; exit 1; }
    [[ -d "$OCI_TF_DIR" ]]          || { echo "ERROR: OCI_TF_DIR not found: $OCI_TF_DIR"; exit 1; }

    echo ">> [oci] Reading credentials for stack $OCI_STACK (workspace $OCI_WS) ..."
    OCI_C="$(awk -F'"' '/^compartment_ocid/{print $2}' "$OCI_TF_DIR/${ENVN}.tfvars")"
    OCI_R="$(awk -F'"' '/^region/{print $2}' "$OCI_TF_DIR/${ENVN}.tfvars")"
    [[ -n "$OCI_C" && -n "$OCI_R" ]] || { echo "ERROR: compartment_ocid/region missing from ${ENVN}.tfvars"; exit 1; }

    # --- LiveKit trio from THIS stack's vault. Filtering by secret name alone is
    # --- wrong once two stacks exist: both vaults hold a LIVEKIT_URL in the same
    # --- compartment. Always scope to the stack's own vault id.
    # Every lookup below tolerates failure (|| true) so a missing resource produces the
    # explicit "empty value for X" error further down, not a silent `set -e` abort.
    VAULT_ID="$(oci kms management vault list --compartment-id "$OCI_C" --region "$OCI_R" \
      --query "data[?\"display-name\"=='${OCI_STACK}-vault' && \"lifecycle-state\"=='ACTIVE'].id | [0]" --raw-output || true)"
    [[ -n "$VAULT_ID" && "$VAULT_ID" != "null" ]] || { echo "ERROR: vault ${OCI_STACK}-vault not found"; exit 1; }

    ocisecret(){
      local id
      id="$(oci vault secret list --compartment-id "$OCI_C" --vault-id "$VAULT_ID" --region "$OCI_R" \
            --name "$1" --query 'data[0].id' --raw-output 2>/dev/null || true)"
      [[ -n "$id" && "$id" != "null" ]] || return 1
      oci secrets secret-bundle get --secret-id "$id" --region "$OCI_R" \
        --query 'data."secret-bundle-content".content' --raw-output | base64 --decode
    }
    LK_URL="$(ocisecret LIVEKIT_URL || true)"
    LK_KEY="$(ocisecret LIVEKIT_API_KEY || true)"
    LK_SEC="$(ocisecret LIVEKIT_API_SECRET || true)"

    # --- S3 recording key pair from the stack's own Terraform workspace state ---
    OCI_S3_PAIR="$(cd "$OCI_TF_DIR" && terraform workspace select "$OCI_WS" >/dev/null && terraform show -json \
      | python3 -c "
import sys,json
d=json.load(sys.stdin)
out=['','']
def walk(m):
    for r in m.get('resources',[]):
        if r.get('type')=='oci_identity_customer_secret_key':
            v=r.get('values',{}); out[0]=v.get('id') or ''; out[1]=v.get('key') or ''
    for c in m.get('child_modules',[]): walk(c)
walk(d.get('values',{}).get('root_module',{}))
print(out[0]); print(out[1])
" || true)"
    OCI_S3_ACCESS="$(printf '%s' "$OCI_S3_PAIR" | sed -n 1p)"
    OCI_S3_SECRET="$(printf '%s' "$OCI_S3_PAIR" | sed -n 2p)"

    # --- API signing credentials from ~/.oci/config (control-plane auth) ---
    OCICFG="${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}"
    cfgval(){ awk -F'= *' -v k="$1" '/^\[/{s=($0=="[DEFAULT]")} s && $1 ~ "^"k"$" {print $2; exit}' "$OCICFG" | tr -d ' '; }
    OCI_TENANCY="$(cfgval tenancy)"
    OCI_USER="$(cfgval user)"
    OCI_FP="$(cfgval fingerprint)"
    OCI_KEYFILE="$(cfgval key_file)"
    OCI_KEYFILE="${OCI_KEYFILE/#\~/$HOME}"
    [[ -f "$OCI_KEYFILE" ]] || { echo "ERROR: API private key not found: $OCI_KEYFILE"; exit 1; }
    OCI_PRIVKEY="$(cat "$OCI_KEYFILE")"

    # --- Master + pool OCIDs from the API ---
    OCI_MASTER_ID="$(oci compute instance list --compartment-id "$OCI_C" --region "$OCI_R" \
      --query "data[?\"display-name\"=='${OCI_STACK}-master-node' && \"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output || true)"
    OCI_POOL_ID="$(oci compute-management instance-pool list --compartment-id "$OCI_C" --region "$OCI_R" \
      --query "data[?\"display-name\"=='${OCI_STACK}-media-pool' && \"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output || true)"

    for pair in "LIVEKIT_URL_OCI=$LK_URL" "LIVEKIT_API_KEY_OCI=$LK_KEY" "LIVEKIT_API_SECRET_OCI=$LK_SEC" \
                "OCI_S3_ACCESS_KEY=$OCI_S3_ACCESS" "OCI_S3_SECRET=$OCI_S3_SECRET" \
                "OCI_TENANCY_OCID=$OCI_TENANCY" "OCI_USER_OCID=$OCI_USER" "OCI_KEY_FINGERPRINT=$OCI_FP" \
                "OCI_MASTER_INSTANCE_ID=$OCI_MASTER_ID" "OCI_MEDIA_POOL_ID=$OCI_POOL_ID"; do
      val="${pair#*=}"; [[ -n "$val" && "$val" != "None" && "$val" != "null" ]] || { echo "ERROR: empty value for ${pair%%=*}"; exit 1; }
    done

    echo ">> [oci] Resolved (secret values masked):"
    echo "     LIVEKIT_URL_OCI        = $LK_URL"
    echo "     LIVEKIT_API_KEY_OCI    = ${LK_KEY:0:4}******"
    echo "     LIVEKIT_API_SECRET_OCI = ******"
    echo "     OCI_S3_ACCESS_KEY      = ${OCI_S3_ACCESS:0:8}******"
    echo "     OCI_MASTER_INSTANCE_ID = $OCI_MASTER_ID"
    echo "     OCI_MEDIA_POOL_ID      = $OCI_POOL_ID"

    echo ">> [oci] Writing Firebase secrets to $PROJECT ..."
    setsecret LIVEKIT_URL_OCI        "$LK_URL"
    setsecret LIVEKIT_API_KEY_OCI    "$LK_KEY"
    setsecret LIVEKIT_API_SECRET_OCI "$LK_SEC"
    setsecret OCI_S3_ACCESS_KEY      "$OCI_S3_ACCESS"
    setsecret OCI_S3_SECRET          "$OCI_S3_SECRET"
    setsecret OCI_TENANCY_OCID       "$OCI_TENANCY"
    setsecret OCI_USER_OCID          "$OCI_USER"
    setsecret OCI_KEY_FINGERPRINT    "$OCI_FP"
    setsecret OCI_API_PRIVATE_KEY    "$OCI_PRIVKEY"
    setsecret OCI_MASTER_INSTANCE_ID "$OCI_MASTER_ID"
    setsecret OCI_MEDIA_POOL_ID      "$OCI_POOL_ID"
  fi
fi

# =================== 3. DEPLOY ===================
if [[ "$MODE" == "all" || "$MODE" == "deploy" ]]; then
  command -v firebase >/dev/null || { echo "firebase CLI not found"; exit 1; }
  grep -q '"index.emulator.js"' "$PKG" || echo "WARN: package.json main is not index.emulator.js — check before restore"

  restore_main(){ perl -i -pe 's/"main":\s*"index\.openvidu-deploy\.js"/"main": "index.emulator.js"/' "$PKG"; echo ">> restored package.json main -> index.emulator.js"; }
  trap restore_main EXIT

  echo ">> Flipping package.json main -> index.openvidu-deploy.js"
  perl -i -pe 's/"main":\s*"index\.emulator\.js"/"main": "index.openvidu-deploy.js"/' "$PKG"

  # Shared LiveKit dispatcher — deployed for every provider.
  FUNCS="createOpenViduToken,openViduStartRecording,openViduStopRecording,openViduCloseRoom,muteParticipant,kickParticipant,flushOpenviduCallQuality"
  if [[ "$PROVIDER" == "aws" || "$PROVIDER" == "both" ]]; then
    FUNCS="${FUNCS},onEventOpenVidu,CheckMasternodeStatus,awsEventWebhook,startMasterNodeHTTP,stopMasterNodeHTTP,scaleMediaNodes,getSignedUrlAWS"
  fi
  if [[ "$PROVIDER" == "oci" || "$PROVIDER" == "both" ]]; then
    FUNCS="${FUNCS},onEventOci,CheckOciNodeStatus,ociEventWebhook,startOciMasterHTTP,stopOciMasterHTTP,scaleOciMediaNodes,getSignedUrlOci"
  fi
  ONLY="$(echo "$FUNCS" | sed 's/[^,]*/functions:&/g')"

  echo ">> Deploying to $PROJECT (targeted; other functions untouched) ..."
  echo "   $FUNCS"
  ( cd "$PROJECT_ROOT" && firebase deploy --project "$PROJECT" --only "$ONLY" )
  # trap restores main on exit
fi

echo ">> Done ($ENVN / $PROJECT / $PROVIDER)."
