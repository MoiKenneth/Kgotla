# Free hosting

Kgotla is one Node.js server plus a PostgreSQL database. Two free ways to run it on the internet:

| | **A. Render + Neon** (recommended to start) | **B. Your own computer + Cloudflare Tunnel** |
|---|---|---|
| Cost | Free | Free (you supply the computer and power) |
| Server | Render free web service (512 MB) | Any always-on PC or small server with Docker |
| Database | Neon free Postgres | Postgres in Docker on the same machine |
| HTTPS address | `https://kgotla-bw.onrender.com`, or your own domain through Cloudflare | Your domain through Cloudflare, e.g. `https://app.kgotla.co.bw` |
| Catch | Sleeps after 15 minutes without visitors; the next visit takes about a minute to wake it. Free plans have usage limits. | Only up while that machine and its internet connection are up |
| Good for | Demos, pilots, showing partners | An always-on pilot without a cloud bill |

Cloudflare (free plan) can sit in front of either: your domain's DNS, HTTPS, caching of the web app, and DDoS protection.

> Cloudflare Workers and Pages on their own cannot run Kgotla as it is: it needs a long-running server and PostgreSQL. Cloudflare is used here for the domain, HTTPS and the tunnel.

## A. Render + Neon

1. **Neon**: sign up at <https://neon.tech> (GitHub sign-in works) and create a project in an AWS Europe region (closest free region to Southern Africa). Copy the **direct** connection string (not the pooled one); it ends with `?sslmode=require`.
2. **Render**: sign up at <https://render.com> and choose **New → Blueprint**, then point it at `https://github.com/MoiKenneth/Kgotla`. Render reads `render.yaml`, asks for `DATABASE_URL` (paste the Neon string) and the optional keys, generates the secrets, and builds the Docker image.
3. Open the address Render gives you. The first start runs the database migrations and loads the demo cell.
4. The demo officer password and first admin password are under the service's **Environment** tab (`DEMO_OFFICER_PASSWORD`, `ADMIN_BOOTSTRAP_PASSWORD`).
5. To go live with real sign-ups and money, change `DEMO_MODE` to `false` and `NODE_ENV` to `production`, add the PayPal, DPO and Twilio keys ([GO-LIVE.md](GO-LIVE.md)), and use a **new** Neon database (live and demo data never share a database).

Every push to `main` redeploys automatically.

### Your own domain with Cloudflare

1. Add your domain to Cloudflare (free plan) and change its nameservers at your registrar.
2. In Render: service → **Settings → Custom domains** → add `app.yourdomain`.
3. In Cloudflare DNS: add the `CNAME app → kgotla-bw.onrender.com` record Render shows. Set SSL/TLS mode to **Full (strict)**.
4. Set `PUBLIC_BASE_URL=https://app.yourdomain` in Render, so links in SMS, payment returns and webhooks use your domain.

## B. Your own computer + Cloudflare Tunnel

1. Install Docker on the machine and clone the repository.
2. In Cloudflare: **Zero Trust → Networks → Tunnels → Create a tunnel** (cloudflared). Add a public hostname such as `app.yourdomain` pointing to `http://app:8080`, and copy the tunnel token.
3. Create `.env` next to `docker-compose.tunnel.yml` with `TUNNEL_TOKEN`, `PUBLIC_BASE_URL`, `KGOTLA_SECRET` (`openssl rand -base64 48`) and `POSTGRES_PASSWORD`.
4. Run `docker compose -f docker-compose.tunnel.yml up -d --build`.

No ports need opening on your router, and Cloudflare provides HTTPS. Back up the `pgdata` volume regularly, for example with a nightly `pg_dump` to another disk or cloud storage.

## When to move to Azure

Move once real money and real citizens' data are involved at scale: when you need no sleep, private networking, backups with point-in-time restore, and an agreement your regulator accepts. The Azure templates in `infra/` are ready ([DEPLOY.md](DEPLOY.md)).
