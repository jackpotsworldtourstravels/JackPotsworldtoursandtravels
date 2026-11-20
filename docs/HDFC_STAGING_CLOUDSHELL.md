# HDFC UAT staging: AWS CloudShell commands (STAGING ONLY, for owner review)

Prepared 2026-11-09. **Nothing here has been run.** The owner reviews and runs each block.
Claude has no AWS access and ran none of it.

Rules baked into every block:
- Region `ap-south-1`. Every resource is named or tagged `jpw-staging` (`Project=jpw-staging`).
- Nothing modifies, stops, resizes or attaches to the production instance `i-017fb7b3879281012`
  (`jackpotsworld-web`), the production RDS `jackpotsworld-db`, its security groups, its role
  `jackpotsworld-ec2-role`, its Elastic IP, its S3 bucket, or any production SSM parameter.
  Blocks 2-5 start by refusing to run if they are pointed at it.
- No secret ever goes in a command line, a script, an SSM command or CloudShell history. Secrets
  are typed into files inside the Session Manager browser terminal (Block 4).
- Do **not** run Block 2 until the cost summary in `docs/HDFC_STAGING_PLAN.md` is approved.

Variables used throughout (set them once per CloudShell session):

```bash
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1
export PROD_INSTANCE=i-017fb7b3879281012     # for the guard only; never a target
export STG=jpw-staging
```

---

## Block 1: read-only AWS inspection (changes nothing)

```bash
aws sts get-caller-identity
aws ec2 describe-instances --filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,PublicIpAddress,Tags[?Key==`Name`]|[0].Value]' --output table
aws ec2 describe-vpcs --query 'Vpcs[].[VpcId,IsDefault,CidrBlock]' --output table
aws ec2 describe-subnets --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone,MapPublicIpOnLaunch]' --output table
aws ec2 describe-security-groups --query 'SecurityGroups[].[GroupId,GroupName,VpcId]' --output table
aws ec2 describe-addresses --query 'Addresses[].[PublicIp,AllocationId,InstanceId]' --output table
aws ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text
aws iam get-role --role-name jpw-staging-ssm-role 2>&1 | head -3     # expect NoSuchEntity until Block 2
aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameter.[Value,LastModifiedDate]' --output text
aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A \
  --query 'Quota.Value' --output text 2>&1 | head -2                # running on-demand standard vCPUs
```

Write down: the VPC id and one public subnet id you want (same AZ style as production is fine),
and the AMI id printed on the SSM line.

---

## Block 2: create the staging infrastructure (run only after cost approval)

Fill in the two values from Block 1, then run top to bottom, stopping at any error.

```bash
set -euo pipefail
export VPC_ID=<vpc-id from block 1>
export SUBNET_ID=<public subnet-id from block 1>
export AMI_ID=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text)
echo "VPC=$VPC_ID SUBNET=$SUBNET_ID AMI=$AMI_ID"

# 2a. Security group: web only. NO SSH, NO database port. 80 is needed for certificate issuance and
#     443 for the site AND HDFC's callbacks (HDFC source IPs are unconfirmed, so it stays open).
SG_ID=$(aws ec2 create-security-group --group-name $STG-sg --description "jpw staging web" \
  --vpc-id $VPC_ID --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$STG-sg},{Key=Project,Value=$STG}]" \
  --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80  --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0
echo "SG=$SG_ID"

# 2b. A NEW instance role that can only be managed via Session Manager. No S3, no RDS, no secrets.
aws iam create-role --role-name $STG-ssm-role --assume-role-policy-document '{
  "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --tags Key=Project,Value=$STG >/dev/null
aws iam attach-role-policy --role-name $STG-ssm-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name $STG-ssm-profile >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name $STG-ssm-profile --role-name $STG-ssm-role
sleep 15   # IAM propagation

# 2c. The instance: t4g.medium (4 GB; owner preference, see HDFC_STAGING_PLAN.md section 2), 20 GB encrypted root + 20 GB encrypted DATA volume that SURVIVES
#     instance termination, IMDSv2 required, no SSH key.
aws ec2 run-instances --image-id $AMI_ID --instance-type t4g.medium \
  --subnet-id $SUBNET_ID --security-group-ids $SG_ID --associate-public-ip-address \
  --iam-instance-profile Name=$STG-ssm-profile \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings \
    'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    'DeviceName=/dev/sdf,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=false}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$STG},{Key=Project,Value=$STG}]" \
                       "ResourceType=volume,Tags=[{Key=Project,Value=$STG}]" \
  --query 'Instances[0].InstanceId' --output text | tee /tmp/stg_instance_id
export IID=$(cat /tmp/stg_instance_id)
[ "$IID" != "$PROD_INSTANCE" ] || { echo "REFUSING: that is the production instance"; exit 1; }
aws ec2 wait instance-running --instance-ids $IID

# 2d. The stable public IP. Billed as a public IPv4 address (see cost table).
ALLOC=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$STG-eip},{Key=Project,Value=$STG}]" \
  --query AllocationId --output text)
aws ec2 associate-address --instance-id $IID --allocation-id $ALLOC
aws ec2 describe-addresses --allocation-ids $ALLOC --query 'Addresses[0].PublicIp' --output text
```

**Send me the printed public IP.** That is the value for the DNS record (Block 3). The instance
id `$IID` is also needed later; it is saved in `/tmp/stg_instance_id` for this CloudShell session.

---

## Block 3: DNS and networking verification

DNS record (in your DNS provider, **only after** you have the Elastic IP; do not create it earlier):

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `uat` (that is `uat.jackpotsworldtours.com`) | the staging Elastic IP | 300 |

Do **not** add a `www.uat` record, and do **not** add a wildcard. Never point `uat` at the
production IP.

```bash
export IID=$(cat /tmp/stg_instance_id); export EIP=<staging elastic ip>
[ "$IID" != "i-017fb7b3879281012" ] || { echo "REFUSING: production"; exit 1; }
aws ec2 describe-instances --instance-ids $IID --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress,MetadataOptions.HttpTokens]' --output text
# The record must resolve to the staging IP and NOT to production's:
dig +short uat.jackpotsworldtours.com @1.1.1.1
dig +short jackpotsworldtours.com @1.1.1.1
# SSM can see the instance (needed for Block 4/5):
aws ssm describe-instance-information --filters Key=InstanceIds,Values=$IID --query 'InstanceInformationList[0].PingStatus' --output text
# Ports: 80 should answer (Caddy, once deployed); 5432 and 6379 must NOT answer from outside:
for p in 80 443 5432 6379; do timeout 4 bash -c "echo > /dev/tcp/$EIP/$p" 2>/dev/null && echo "port $p OPEN" || echo "port $p closed"; done
```

Expected before deployment: 80/443 closed (nothing listening yet), 5432/6379 closed, the `uat`
record equals `$EIP` and differs from the apex record.

---

## Block 4: staging application deployment

Prerequisite (**blocker, needs your decision**): the code staging must run, including the
HDFC hardening and `deploy/staging/` files, exists only as local uncommitted changes. The server
can only clone what is on GitHub. Approve pushing a **separate branch** (suggested
`staging/hdfc-uat`, not `main`) and tell me; I will not commit or push without that approval.
Until then `BRANCH` below has nothing to point at.

### 4a. Prepare the server (commands via SSM; they contain no secrets)

```bash
export IID=$(cat /tmp/stg_instance_id)
[ "$IID" != "i-017fb7b3879281012" ] || { echo "REFUSING: production"; exit 1; }
run_remote() {   # usage: run_remote '<shell commands>'  -> prints the command's output
  jq -n --arg c "$1" '{commands:[$c]}' > /tmp/p.json
  CID=$(aws ssm send-command --instance-ids $IID --document-name AWS-RunShellScript \
        --parameters file:///tmp/p.json --query Command.CommandId --output text)
  for i in $(seq 1 60); do
    S=$(aws ssm get-command-invocation --command-id $CID --instance-id $IID --query Status --output text 2>/dev/null || echo Pending)
    case $S in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5
  done
  aws ssm get-command-invocation --command-id $CID --instance-id $IID --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
}

# Docker, git, compose (same procedure as docs/AWS_DEPLOYMENT.md, Arm build):
run_remote 'set -e
dnf update -y && dnf install -y docker git && systemctl enable --now docker && usermod -aG docker ec2-user
COMPOSE_TAG=v2.29.7   # pinned (assumed to exist; production used "latest"). Change if the download 404s.
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose "https://github.com/docker/compose/releases/download/${COMPOSE_TAG}/docker-compose-linux-aarch64"
chmod 0755 /usr/libexec/docker/cli-plugins/docker-compose
docker compose version'

# Inspect the data disk BEFORE formatting anything. Expect a 20G disk with no filesystem (nvme1n1):
run_remote 'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT'
```

Read the `lsblk` output. Only if the 20G data disk shows an **empty FSTYPE**, format and mount it
(replace `nvme1n1` if yours differs; **never** run mkfs on the disk that has `/` mounted):

```bash
run_remote 'set -e
DEV=/dev/nvme1n1
[ -z "$(lsblk -no FSTYPE $DEV)" ] || { echo "disk already has a filesystem; stopping"; exit 1; }
mkfs.xfs $DEV
mkdir -p /data
UUID=$(blkid -s UUID -o value $DEV)
echo "UUID=$UUID /data xfs defaults,nofail 0 2" >> /etc/fstab
mount -a && mkdir -p /data/postgres /data/backups && df -h /data'
```

### 4b. Put the code on the server (after the branch exists)

```bash
export BRANCH=<the approved branch name>
run_remote "set -e
sudo -u ec2-user -H bash -c 'cd ~ && git clone --branch $BRANCH https://github.com/jackpotsworldtourstravels/JackPotsworldtoursandtravels.git jpw-staging && cd jpw-staging && git log -1 --oneline'"
```

### 4c. Create the two secret files by hand (no secrets through CloudShell)

1. AWS console -> EC2 -> Instances -> select `jpw-staging` -> **Connect** -> **Session Manager** -> **Connect**.
2. In that browser terminal:

```bash
sudo -iu ec2-user
cd ~/jpw-staging/deploy/staging
cp stack.env.example stack.env && chmod 600 stack.env
cp backend.staging.env.example backend.staging.env && chmod 600 backend.staging.env
# Generate values locally on the server, e.g.:  openssl rand -hex 24
# Basic Auth hash:  docker run --rm caddy:2 caddy hash-password --plaintext '<password you choose>'
nano stack.env            # in this file write each literal $ in the hash as $$
nano backend.staging.env  # HDFC UAT keys, staging webhook pair, SMTP; leave SANDBOX_PAYMENT_CUSTOMER_IDS empty for now
```

Rules: HDFC **UAT** values only; no live HDFC value anywhere; no production DATABASE_URL (the
compose file builds the staging one itself); `JWT_SECRET_KEY` must differ from production.

### 4d. Start it (in the same Session Manager terminal)

```bash
cd ~/jpw-staging/deploy/staging
export DOCKER_BUILDKIT=0 APP_COMMIT=$(git -C ~/jpw-staging rev-parse --short HEAD)
docker compose -f docker-compose.staging.yml --env-file stack.env up -d --build
docker compose -f docker-compose.staging.yml ps
docker compose -f docker-compose.staging.yml logs --tail 40 app      # shows the one-time generated admin password
```

The first build compiles Python wheels (several minutes on `t4g.medium`). Caddy fetches the
certificate once the DNS record from Block 3 resolves to this server.

### 4e. Verify the deployment (from CloudShell, read-only)

```bash
H=https://uat.jackpotsworldtours.com
curl -s -o /dev/null -w "home (no creds): %{http_code}\n"        $H/                         # expect 401 (Basic Auth)
curl -s -o /dev/null -w "health: %{http_code}\n"                 $H/api/health               # expect 200
curl -s -o /dev/null -w "docs: %{http_code}\n"                   $H/docs                     # expect 404
curl -s -o /dev/null -w "openapi: %{http_code}\n"                $H/openapi.json             # expect 404
curl -s -o /dev/null -w "admin api (blocked for everyone): %{http_code}\n" $H/api/admin/payment-reconciliation  # expect 404
curl -s -o /dev/null -w "webhook GET: %{http_code}\n"            $H/api/webhooks/payments/hdfc          # expect 404 (POST only)
curl -s -o /dev/null -w "webhook POST no auth: %{http_code}\n" -X POST -d '{}' -H 'Content-Type: application/json' $H/api/webhooks/payments/hdfc   # expect 401 from the APP
curl -s -o /dev/null -w "return route: %{http_code}\n"           "$H/api/payments/hdfc/return?order_id=none"  # expect 303 or 4xx from the app, not 401 from Caddy
```

The webhook POST test is a **local probe** with no credentials. It is not an HDFC event, and
nothing about it should be reported as a genuine delivery.

---

## Block 5: database and migration verification (inside Session Manager)

```bash
cd ~/jpw-staging/deploy/staging
D="docker compose -f docker-compose.staging.yml --env-file stack.env"
$D exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select current_database(), version();"'
$D exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select version_num from alembic_version;"'
$D exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from customers;"'   # expect 0 before the test customer
$D logs app | grep -i "alembic\|Running upgrade" | tail -5
docker compose -f docker-compose.staging.yml ps --format '{{.Name}} {{.Ports}}'   # postgres/redis must show NO host port
ss -ltnp | grep -E ':(5432|6379)\b' || echo "5432/6379 not listening on the host (good)"
df -h /data
```

Compare `alembic_version` with the head revision on the branch you deployed
(`ls backend/alembic/versions | tail`). The staging database must be empty of real data: only
the schema plus the seeded admin.

### Backups

Nightly dump to the data disk, 7 days kept (run once inside Session Manager):

```bash
sudo tee /usr/local/bin/jpw-staging-backup.sh >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
cd /home/ec2-user/jpw-staging/deploy/staging
docker compose -f docker-compose.staging.yml --env-file stack.env exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /data/backups/jpw_staging_$(date +%F).dump
find /data/backups -name 'jpw_staging_*.dump' -mtime +7 -delete
EOF
sudo chmod 0755 /usr/local/bin/jpw-staging-backup.sh
echo '30 2 * * * root /usr/local/bin/jpw-staging-backup.sh' | sudo tee /etc/cron.d/jpw-staging-backup
sudo dnf install -y cronie && sudo systemctl enable --now crond
sudo /usr/local/bin/jpw-staging-backup.sh && ls -l /data/backups
```

Daily EBS snapshots of the staging DATA volume only, 7 kept (so a backup is not only on the disk it
protects). From CloudShell, staging only. It tags just the staging data volume with a unique tag and
targets only that tag, so no other volume (production included) can match:

```bash
export IID=$(cat /tmp/stg_instance_id); [ "$IID" != "i-017fb7b3879281012" ] || exit 1
VOL=$(aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=$IID Name=attachment.device,Values=/dev/sdf \
      --query 'Volumes[0].VolumeId' --output text)
echo "data volume: $VOL (must NOT be a production volume)"
aws ec2 create-tags --resources $VOL --tags Key=jpw-staging-snapshot,Value=daily

# DLM needs a service role. This only creates it if the account does not have it yet.
aws iam get-role --role-name AWSDataLifecycleManagerDefaultRole >/dev/null 2>&1 || aws dlm create-default-role
ROLE_ARN=$(aws iam get-role --role-name AWSDataLifecycleManagerDefaultRole --query Role.Arn --output text)

aws dlm create-lifecycle-policy --description "jpw-staging data daily x7" --state ENABLED \
  --execution-role-arn "$ROLE_ARN" --tags Project=jpw-staging --policy-details '{
    "ResourceTypes":["VOLUME"],
    "TargetTags":[{"Key":"jpw-staging-snapshot","Value":"daily"}],
    "Schedules":[{"Name":"daily","CreateRule":{"Interval":24,"IntervalUnit":"HOURS","Times":["21:00"]},
                  "RetainRule":{"Count":7},"CopyTags":true,
                  "TagsToAdd":[{"Key":"Project","Value":"jpw-staging"}]}]}'
aws dlm get-lifecycle-policies --query 'Policies[].[PolicyId,Description,State]' --output table
```

(21:00 is UTC, which is 02:30 IST. The dump cron runs at 02:30 server time, which is UTC on Amazon
Linux, so each snapshot holds the previous day's dump. To restore: create a volume from the snapshot, attach it to a NEW staging
instance, mount at `/data`.)

---

## Block 6: stop to save money / tear down (staging only)

Stop between test windows (EBS and the IP keep billing, compute does not):

```bash
aws ec2 stop-instances --instance-ids $(cat /tmp/stg_instance_id)
```

Full teardown only when staging is finished. It deletes the data volume if you add the last
line, so take a final backup first. Every command is keyed to `Project=jpw-staging`.

```bash
IID=$(cat /tmp/stg_instance_id); [ "$IID" != "i-017fb7b3879281012" ] || exit 1
aws ec2 terminate-instances --instance-ids $IID && aws ec2 wait instance-terminated --instance-ids $IID
aws dlm delete-lifecycle-policy --policy-id <staging DLM policy id>
aws ec2 release-address --allocation-id <staging allocation id>
aws ec2 delete-security-group --group-id <staging sg id>
aws iam remove-role-from-instance-profile --instance-profile-name jpw-staging-ssm-profile --role-name jpw-staging-ssm-role
aws iam delete-instance-profile --instance-profile-name jpw-staging-ssm-profile
aws iam detach-role-policy --role-name jpw-staging-ssm-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --role-name jpw-staging-ssm-role
# aws ec2 delete-volume --volume-id <staging data volume id>     # destroys the staging database
```

Then delete the `uat` DNS record.
