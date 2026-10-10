#!/usr/bin/env bash
# OSRM 仙台版を Cloud Run に置く。使い方：osrm/deploy.sh <project>
# 公開しない（IAM 認証）。業務関数のサービスアカウントにだけ呼び出しを許す。
set -euo pipefail
PROJECT="${1:?使い方: osrm/deploy.sh <project>}"
REGION=asia-northeast1
SERVICE=osrm-sendai
TAG="$(date +%Y%m%d)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/osrm/${SERVICE}:${TAG}"
cd "$(dirname "$0")"

gcloud artifacts repositories describe osrm --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create osrm --project "$PROJECT" --location "$REGION" --repository-format docker
# 地図データは取得した日のもの。タグ（日付）で版を区別する
gcloud builds submit --project "$PROJECT" --region "$REGION" --tag "$IMAGE" --machine-type e2-highcpu-8 .
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --no-allow-unauthenticated --port 8080 --memory 1Gi --cpu 1 \
  --min-instances 0 --max-instances 2 --concurrency 20
NUMBER="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${NUMBER}-compute@developer.gserviceaccount.com" --role roles/run.invoker
echo "OSRM_URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo "↑ を functions/.env.${PROJECT} に書いて functions:default をデプロイする"
