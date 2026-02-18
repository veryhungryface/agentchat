# issamGPT Deployment Guide (Ubuntu 22.04)

This project runs as:

1. Frontend: Vercel (React/Vite build)
2. Backend API: Linux server running `server.js` (Express + SSE)

You only need to run backend on your Linux server. Do not run Vite dev server in production.

## 1. Server Prerequisites

```bash
sudo apt update
sudo apt install -y git curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2. Clone and Install

```bash
git clone https://github.com/veryhungryface/agentchat.git
cd agentchat
npm ci --omit=dev
```

## 3. Create `.env`

Create `.env` in project root:

```env
PORT=3001

ORCHESTRATOR_MODEL=gemini-2.5-flash-lite
RESPONSE_MODEL=glm-4.7-flash
FOLLOWUP_MODEL=glm-4.7-flash

GEMINI_API_KEY=YOUR_GEMINI_KEY
OPENAI_API_KEY=YOUR_OPENAI_KEY
GLM_API_KEY=YOUR_GLM_KEY
GLM_BASE_URL=https://api.z.ai/api/coding/paas/v4
TAVILY_API_KEY=YOUR_TAVILY_KEY
```

Optional:

1. `OPENAI_BASE_URL` (if using custom OpenAI-compatible endpoint)
2. `GEMINI_BASE_URL` (if using custom Gemini endpoint)

## 4. Run Backend with PM2

```bash
sudo npm i -g pm2
pm2 start server.js --name issamgpt-api
pm2 save
pm2 startup
pm2 status
pm2 logs issamgpt-api
```

## 5. Configure Nginx Reverse Proxy

Create `/etc/nginx/sites-available/issamgpt-api`:

```nginx
server {
  listen 80;
  server_name api.your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
    proxy_buffering off;
  }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/issamgpt-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Enable HTTPS (Certbot)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.com
```

## 7. Set Vercel Environment Variable

In Vercel project settings:

1. Add `VITE_API_URL=https://api.your-domain.com`
2. Save
3. Redeploy the frontend

## 8. Health Check

```bash
curl -i https://api.your-domain.com/api/search -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"test","maxResults":3}'
```

If `TAVILY_API_KEY` is missing, you should see a clear error message. If keys are set correctly, API returns search JSON.

## 9. Update Deployment

```bash
cd agentchat
git pull origin main
npm ci --omit=dev
pm2 restart issamgpt-api
pm2 logs issamgpt-api
```

## Notes

1. Never commit `.env` to Git.
2. If keys were exposed before, revoke and reissue them.
3. In production, run `npm run server` via PM2. Do not use `npm run dev`.
