# Deploying to AWS — step by step

One EC2 instance running the Docker image, RDS Postgres for the database, S3
for booking documents, and a domain with automatic TLS.

Work through the sections in order. Later steps depend on identifiers produced
by earlier ones, and the ordering avoids the two changes that are annoying to
make afterwards (a database with no database in it, and a security group that
has to be rewritten once EC2 exists).

Console wording shifts between AWS revisions. Where a label here doesn't match
what you see, the setting is almost always under **Additional configuration**,
which is collapsed by default on nearly every RDS and EC2 page.

**Everything in this document happens in one AWS region.** Pick it now and do
not change it — `ap-south-1` (Mumbai) if your merchants are in India. RDS, S3
and EC2 must sit in the same region, and RDS and EC2 in the same VPC, or they
cannot reach each other.

---

## What this application needs

Established by inspecting the running system, not assumed:

| | |
|---|---|
| Database | PostgreSQL, 12 tables, ~20 MB, no extensions beyond `plpgsql` |
| Version | Anything 14 or newer. Development runs 18.4; no version-specific SQL is used |
| Schema creation | Automatic. `deploy/docker-entrypoint.sh` runs `alembic upgrade head` on every container start |
| Document storage | S3, private bucket, via the instance's IAM role |
| Ports | The container serves API *and* frontend on 8000, single origin. Only Caddy is public |

---

## Step 0 — Prerequisites

You must do these yourself; they involve account creation and credentials.

1. An AWS account with billing set up.
2. An SSH key pair: EC2 → **Key pairs** → **Create key pair**, type `ed25519`,
   format `.pem`. The private key downloads once and cannot be re-downloaded.
   Store it somewhere you back up.
3. Your domain's DNS control panel open in another tab.

> **On cost.** AWS changed the free tier during 2025: new accounts receive
> credits over a limited window rather than twelve months of free
> `db.t3.micro`. Check the Billing page for what your account actually has.
> Past any credits, this stack runs roughly **$25–30/month** — about $13 for
> `db.t4g.micro`, about $8 for `t4g.small`, the rest storage and bandwidth. S3
> for a few thousand documents is cents.

---

## Step 1 — Security groups

Create these **before** RDS, so the database can be locked to the application
from the moment it exists. EC2 → **Security Groups** → **Create security
group**, twice.

**`jackpotsworld-app-sg`** — for the web server.

| Type | Port | Source | Why |
|---|---|---|---|
| HTTP | 80 | `0.0.0.0/0` | Caddy redirects to 443; also serves the ACME challenge |
| HTTPS | 443 | `0.0.0.0/0` | The site |
| SSH | 22 | **My IP** | Not `0.0.0.0/0`. An open SSH port is scanned within minutes |

**`jackpotsworld-db-sg`** — for the database. One inbound rule:

| Type | Port | Source |
|---|---|---|
| PostgreSQL | 5432 | **`jackpotsworld-app-sg`** |

Set the source by typing `sg-` in the field and selecting the app group — not
a CIDR block, not "Anywhere". This is the rule that keeps passport scans off
the public internet, and referencing the group means it keeps working when the
instance is replaced and its IP changes.

---

## Step 2 — RDS Postgres

RDS → **Create database** → engine **PostgreSQL** → creation method
**Full configuration**.

> ### Pick PostgreSQL, not Aurora
>
> The engine grid offers both **PostgreSQL** and **Aurora (PostgreSQL
> Compatible)**. They are different products at wildly different prices, and
> the names invite the mistake.
>
> Aurora has **no free tier**, starts at `db.r7g.large` (16 GiB RAM), defaults
> to a replica in a second availability zone, and turns on DevOps Guru,
> Enhanced Monitoring and Database Insights Advanced. A default Aurora cluster
> in ap-south-1 estimates at about **USD 595/month**. The equivalent RDS
> PostgreSQL instance for this application is free-tier eligible and about
> **USD 13/month** afterwards.
>
> Two tells that the wrong engine is selected: the **Free tier** template
> disappears from the Templates section, and the form grows Aurora-only
> sections — *Cluster scalability type*, *Cluster storage configuration*,
> *Read replica write forwarding*, *Babelfish settings*. If you see any of
> those, go back to the top and choose plain **PostgreSQL**.
>
> Aurora is a good product; it is built for workloads far larger than 12
> tables and 20 MB. Nothing in this application benefits from it.

Recent consoles label this pair *Full configuration* / *Easy create*; older ones
say *Standard create* / *Easy create*. Either way, take the left-hand one.
**Easy create does not offer "Initial database name"**, so it produces a
Postgres server with no database on it — and it hides the public-access and
security-group settings as well. The omission is invisible until the app boots
and Alembic fails against a database that was never created.

**Engine:** PostgreSQL, version 17 (or 18 if your region offers it).

**Templates:** **Sandbox** (called *Free tier* in older consoles). Not
**Production**.

> ### The template decides almost everything, including the bill
>
> Choosing *Production* is the single most expensive click on this page,
> because it silently sets four other fields:
>
> | It sets | To | Cost effect |
> |---|---|---|
> | Deployment | Multi-AZ DB **cluster** (3 instances) | ~$600/mo — three servers |
> | Instance class | `db.m5d.large` | vs `db.t4g.micro` |
> | Storage type | Provisioned IOPS **io2** | ~$945/mo — 100 GiB and 1,000 IOPS minimums |
> | Monitoring | Insights Advanced, Performance Insights (15-month retention), Enhanced Monitoring, DevOps Guru | each billed separately |
>
> A Production-template PostgreSQL instance in ap-south-1 estimates at about
> **USD 1,700/month**. The same engine on the Sandbox template, sized for this
> application, is free-tier eligible and about **USD 13/month** after that.
>
> io2 storage is the biggest single line and the least justified: it is built
> for write-heavy transactional systems, and its 100 GiB floor is 5,000× this
> database. Use gp3.
>
> **Always read the "Estimated monthly costs" box at the bottom of the page
> before clicking Create.** Every trap on this page is visible there, and
> nowhere else.

If *Production* was selected at any point, also re-check **Deployment options**
(should be *Single-AZ DB instance deployment*), **Storage type** (gp3),
**Instance configuration** (*Burstable classes* → `db.t4g.micro`) and the whole
Monitoring section — changing the template afterwards does not always reset
them. And untick **"Show only versions that support the Multi-AZ DB cluster"**
under Engine version, or the version list stays filtered to cluster-capable
releases.

| Setting | Value |
|---|---|
| DB instance identifier | `jackpotsworld-db` |
| Master username | `jpwadmin` — avoid `admin` and `root`, which RDS reserves |
| Credentials management | **Self managed**, and choose a strong password — *Managed in AWS Secrets Manager* is the default on some engines and bills separately |
| Deployment options | **Single-AZ DB instance deployment (1 instance)** |
| Instance class | **Burstable classes (includes t classes)** → `db.t4g.micro` |
| Storage type | **General Purpose SSD (gp3)**, 20 GiB — never Provisioned IOPS io2 |
| Monitoring | Database Insights **Standard**; Performance Insights, Enhanced Monitoring and DevOps Guru all **off** |
| Enable storage autoscaling | Yes, max 100 GiB |
| Multi-AZ | No |
| Compute resource | **Don't connect to an EC2 compute resource** |
| VPC | Default |
| Public access | **No** |
| VPC security group | **Choose existing** → `jackpotsworld-db-sg`, and remove `default` |

Then open **Additional configuration** — the collapsed section near the bottom,
not the one under Connectivity:

| Setting | Value |
|---|---|
| **Initial database name** | **`jackpotsworldtours`** |
| Backup retention | 7 days |
| Encryption | Enabled |
| Deletion protection | Enabled |

> **The one that catches everyone:** if *Initial database name* is left blank,
> RDS gives you a server with no database on it. Nothing complains until the
> app boots and Alembic fails against a database that isn't there. The name
> must be exactly `jackpotsworldtours` unless you also change `DATABASE_URL`.

**Create database**, then wait — roughly 5–10 minutes until status is
*Available*. Copy the **Endpoint** from the Connectivity & security tab; it
looks like `jackpotsworld-db.abc123xyz.ap-south-1.rds.amazonaws.com`.

Your connection string, for later:

```
postgresql+psycopg2://jpwadmin:YOUR_PASSWORD@YOUR_ENDPOINT:5432/jackpotsworldtours
```

If the password contains `@ : / ? # [ ] %`, percent-encode it or the URL parses
wrongly — `@` becomes `%40`, `#` becomes `%23`. Choosing a password of letters
and digits avoids the problem entirely.

> Because public access is off, you cannot reach this from your laptop with
> pgAdmin or DBeaver. Once the server exists you can tunnel:
> `ssh -i key.pem -L 5432:YOUR_ENDPOINT:5432 ec2-user@YOUR_SERVER_IP`, then
> connect to `localhost:5432`.

---

## Step 3 — The S3 bucket

S3 → **Create bucket**.

| Setting | Value |
|---|---|
| Bucket name | `jackpotsworld-documents` — globally unique, so add a suffix if taken |
| Region | Same as everything else |
| **Block all public access** | **On.** Every checkbox |
| Bucket Versioning | Enable |
| Default encryption | SSE-S3 (`AES256`) |

Versioning is worth the pennies: a document deleted by mistake, or by a bug,
is recoverable rather than gone.

The bucket must never be public. The application streams every download
through its own authenticated endpoint and issues no presigned URLs, so
nothing is expected to reach these objects by URL. A public bucket would make
every passport scan world-readable regardless of what the application does.

---

## Step 4 — IAM role for the instance

This is how the server reaches S3 **without any access keys existing**. Keys in
a `.env` file get committed, copied into chat, and pasted into tickets; a role
cannot leak that way because there is nothing to copy.

IAM → **Policies** → **Create policy** → **JSON**. Replace the bucket name:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BookingDocuments",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::jackpotsworld-documents/documents/*"
    }
  ]
}
```

Name it `jackpotsworld-documents-rw`.

Scoped deliberately tighter than the usual template. It grants no
`s3:ListBucket`, because the code never lists — so a compromised instance
cannot enumerate what documents exist, only fetch a key it already knows. The
resource ends in `/documents/*`, matching `S3_PREFIX`, so the role cannot touch
anything else you later put in this bucket. `AbortMultipartUpload` is there
because uploads above ~8 MB become multipart, and without it a failed large
upload leaves a part that is billed and never cleaned up.

Then IAM → **Roles** → **Create role** → **AWS service** → **EC2** → attach
`jackpotsworld-documents-rw` → name it `jackpotsworld-ec2-role`.

---

## Step 5 — The EC2 instance

EC2 → **Launch instance**.

| Setting | Value |
|---|---|
| Name | `jackpotsworld-web` |
| AMI | Amazon Linux 2023 |
| Architecture | 64-bit (Arm) |
| Instance type | `t4g.small` |
| Key pair | The one from Step 0 |
| VPC | Same as RDS |
| Auto-assign public IP | Enable |
| Firewall | **Select existing** → `jackpotsworld-app-sg` |
| Storage | 20 GiB gp3 |
| **Advanced → IAM instance profile** | `jackpotsworld-ec2-role` |

`t4g.small` (2 GB) rather than `t4g.micro` (1 GB): the image builds Python
wheels on first deploy, and 1 GB runs out of memory partway through with an
error that looks like a network failure.

Under **Advanced details → User data**, paste this to install Docker at first
boot:

```bash
#!/bin/bash
dnf update -y
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user
```

Launch. Then give it a fixed address — EC2 → **Elastic IPs** → **Allocate**,
then **Associate** it with the instance. Without this the public IP changes on
every stop/start and your DNS silently points at nothing.

---

## Step 6 — Point the domain at it

In your registrar's DNS panel:

| Record | Name | Value |
|---|---|---|
| A | `@` | Your Elastic IP |
| A | `www` | Your Elastic IP |

**Do this before Step 8.** Let's Encrypt issues a certificate by connecting
back to your domain name; until DNS resolves to this server, TLS cannot be
obtained and Caddy will retry in a loop.

Check it has taken effect — propagation is usually minutes, occasionally an
hour:

```bash
nslookup yourdomain.com
```

---

## Step 7 — Configuration on the server

SSH in:

```bash
ssh -i /path/to/your-key.pem ec2-user@YOUR_ELASTIC_IP
```

Clone the repository. If it is private, generate a deploy key or use a personal
access token:

```bash
git clone https://github.com/jackpotsworldtourstravels/JackPotsworldtoursandtravels.git
cd JackPotsworldtoursandtravels
```

Generate a JWT secret and keep the output:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Write the application settings:

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

The values that must change:

```
DATABASE_URL=postgresql+psycopg2://jpwadmin:YOUR_PASSWORD@YOUR_RDS_ENDPOINT:5432/jackpotsworldtours
JWT_SECRET_KEY=the-64-character-value-you-just-generated
FRONTEND_BASE_URL=https://yourdomain.com
CORS_ORIGINS=https://yourdomain.com
STORAGE_BACKEND=s3
S3_BUCKET=jackpotsworld-documents
S3_REGION=ap-south-1
```

Leave `S3_PREFIX=documents` as it is — the IAM policy in Step 4 is written
against that exact prefix. Add no AWS keys: the instance role supplies
credentials, and boto3 finds them by itself.

Then the domain for Caddy:

```bash
echo "SITE_DOMAIN=yourdomain.com" > deploy/.env
```

Both files are gitignored, so neither can reach GitHub.

---

## Step 8 — Start it

```bash
cd deploy && docker compose up -d --build
```

First build takes a few minutes. On start the app runs `alembic upgrade head`
against RDS, creating all 12 tables, and Caddy obtains the certificate.

Watch it happen:

```bash
docker compose logs -f
```

**Capture the admin password.** The `0003_seed_admin` migration generates one
and prints it to the log exactly once, on the run that creates the schema:

```bash
docker compose logs app | grep -i -A3 "admin"
```

If you miss it, `docker compose down && docker compose up -d` will not print it
again — the migration has already run. You would reset it through the database.

---

## Step 9 — Verify

```bash
curl -I https://yourdomain.com/api/health
```

Expect `HTTP/2 200`. Then, from your laptop rather than the server:

- Load `https://yourdomain.com` — the landing page, with a valid certificate.
- Sign in with the seeded admin account and **change that password**.
- Create a test merchant, raise a booking request, and upload a document.
- Confirm the object appears in S3 under `documents/requests/<id>/`.
- Download it back through the portal and check the file opens.

That last pair is the real test: it proves the IAM role, the bucket, the
prefix and the streaming download all agree with each other.

---

## Afterwards

**Deploying a change**

```bash
cd ~/JackPotsworldtoursandtravels && git pull && cd deploy && docker compose up -d --build
```

Migrations run automatically on restart. Expect a few seconds of downtime; this
is a single instance.

**Backups.** RDS keeps 7 days of automated backups and supports point-in-time
restore. S3 versioning covers documents. Neither covers a mistake you notice in
week three — take a manual RDS snapshot before anything structural.

**Logs.** `docker compose logs -f app`, capped at 3 × 10 MB per container so
they cannot fill the disk.

**What is *not* set up here**

- **Email.** `SMTP_*` is empty, so password-reset emails are skipped and only
  logged. Merchant password resets still work through the admin action. Add
  SES or an SMTP provider when you want self-service resets.
- **Monitoring.** Nothing alerts you if the site goes down. A CloudWatch alarm
  on the instance, or any external uptime check, is worth the few minutes.
- **Staging.** This is one environment. Changes go straight to production.
