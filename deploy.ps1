# Deployment to Google Cloud Run
$PROJECT_ID = "buoyant-purpose-475203-t9"
$SERVICE_NAME = "bryan-fpows"
$REGION = "australia-southeast1"

gcloud run deploy $SERVICE_NAME `
  --source . `
  --region $REGION `
  --project $PROJECT_ID `
  --allow-unauthenticated `
  --set-env-vars="SMTP_USER=bryanjosephmay12@gmail.com,SMTP_PASS=gplkzhvdtjdmwjmi,MANAGER_EMAIL=bryan.morales@redadair.com.au,SIMPRO_BASE_URL=https://redmen-uat.simprosuite.com,SIMPRO_ACCESS_TOKEN=6c6b91755ff14c8ff1ffb843c0737955d7a3a88a,SIMPRO_COMPANY_ID=1"
