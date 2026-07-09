#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Point a Firebase project's OpenVidu Cloud Functions at the new-account
# OpenVidu Elastic stack (dev or prod) and deploy them.
#
# What it does:
#   1. Pulls LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the stack's
#      AWS Secrets Manager entry, and derives MASTER_INSTANCE_ID / MEDIA_ASG_NAME
#      from EC2 / Auto Scaling (so no secret is ever hand-copied).
#   2. Writes those 5 Firebase secrets for the target project.
#   3. Temporarily flips functions/package.json "main" -> index.openvidu-deploy.js
#      (so the CLI only sees the OpenVidu exports), deploys the OpenVidu functions
#      with an explicit --only list (never deletes other functions), then restores
#      "main" -> index.emulator.js via an EXIT trap.
#
# Usage:
#   bash scripts/set-secrets-and-deploy.sh dev            # secrets + deploy
#   bash scripts/set-secrets-and-deploy.sh dev secrets    # secrets only
#   bash scripts/set-secrets-and-deploy.sh dev deploy     # deploy only
#
# Optional (prod cutover — set the new-account IAM keys for that project):
#   SET_AWS_ACCESS_KEY='AKIA...' SET_AWS_SECRET='...' bash scripts/set-secrets-and-deploy.sh prod
#
# Requires: aws CLI (logged into account 968234051275), firebase CLI (logged in), python3.
# ---------------------------------------------------------------------------
set -euo pipefail

ENVN="${1:-}"
MODE="${2:-all}"   # all | secrets | deploy
case "$ENVN" in dev|prod) ;; *) echo "Usage: bash $0 <dev|prod> [all|secrets|deploy]"; exit 1;; esac
case "$MODE" in all|secrets|deploy) ;; *) echo "mode must be all|secrets|deploy"; exit 1;; esac

if [[ "$ENVN" == "prod" ]]; then PROJECT="fir-sample-aae4a"; else PROJECT="starlabs-test"; fi
R="ap-south-1"
STACK="OpenViduElastic-${ENVN}"
SECRET_NAME="openvidu-elastic-${R}-${STACK}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FUNCTIONS_DIR="$PROJECT_ROOT/functions"
PKG="$FUNCTIONS_DIR/package.json"

echo "=================================================================="
echo " env=$ENVN  firebase-project=$PROJECT  aws-stack=$STACK  mode=$MODE"
echo "=================================================================="

# ---- prod safety gate ----
if [[ "$ENVN" == "prod" && "${FORCE:-}" != "1" ]]; then
  read -r -p "About to target PRODUCTION ($PROJECT). Type PROD to continue: " ok
  [[ "$ok" == "PROD" ]] || { echo "aborted."; exit 1; }
fi

# =================== 1 + 2. SECRETS ===================
if [[ "$MODE" == "all" || "$MODE" == "secrets" ]]; then
  echo ">> Reading credentials from AWS stack $STACK ..."
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

  # sanity
  for pair in "LIVEKIT_URL=$LIVEKIT_URL" "LIVEKIT_API_KEY=$LIVEKIT_API_KEY" \
              "LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET" "MASTER_INSTANCE_ID=$MASTER_INSTANCE_ID" \
              "MEDIA_ASG_NAME=$MEDIA_ASG_NAME"; do
    val="${pair#*=}"; [[ -n "$val" && "$val" != "None" ]] || { echo "ERROR: empty value for ${pair%%=*}"; exit 1; }
  done

  echo ">> Resolved (secret values masked):"
  echo "     LIVEKIT_URL        = $LIVEKIT_URL"
  echo "     LIVEKIT_API_KEY    = ${LIVEKIT_API_KEY:0:4}******"
  echo "     LIVEKIT_API_SECRET = ******"
  echo "     MASTER_INSTANCE_ID = $MASTER_INSTANCE_ID"
  echo "     MEDIA_ASG_NAME     = $MEDIA_ASG_NAME"

  setsecret(){ printf '%s' "$2" | firebase functions:secrets:set "$1" --project "$PROJECT" --data-file - --force >/dev/null; echo "     set $1"; }
  echo ">> Writing Firebase secrets to $PROJECT ..."
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

# =================== 3. DEPLOY ===================
if [[ "$MODE" == "all" || "$MODE" == "deploy" ]]; then
  command -v firebase >/dev/null || { echo "firebase CLI not found"; exit 1; }
  grep -q '"index.emulator.js"' "$PKG" || echo "WARN: package.json main is not index.emulator.js — check before restore"

  restore_main(){ perl -i -pe 's/"main":\s*"index\.openvidu-deploy\.js"/"main": "index.emulator.js"/' "$PKG"; echo ">> restored package.json main -> index.emulator.js"; }
  trap restore_main EXIT

  echo ">> Flipping package.json main -> index.openvidu-deploy.js"
  perl -i -pe 's/"main":\s*"index\.emulator\.js"/"main": "index.openvidu-deploy.js"/' "$PKG"

  FUNCS="createOpenViduToken,openViduStartRecording,openViduStopRecording,onEventOpenVidu,openViduCloseRoom,CheckMasternodeStatus,awsEventWebhook,startMasterNodeHTTP,stopMasterNodeHTTP,scaleMediaNodes,muteParticipant,kickParticipant,flushOpenviduCallQuality,getSignedUrlAWS"
  ONLY="$(echo "$FUNCS" | sed 's/[^,]*/functions:&/g')"

  echo ">> Deploying to $PROJECT (targeted; other functions untouched) ..."
  ( cd "$PROJECT_ROOT" && firebase deploy --project "$PROJECT" --only "$ONLY" )
  # trap restores main on exit
fi

echo ">> Done ($ENVN / $PROJECT)."
