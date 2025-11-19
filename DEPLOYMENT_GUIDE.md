# Deployment Guide: CreativeDrive to Bynder DAM Migration

## Prerequisites Checklist

Before deploying, ensure you have:

- [ ] AWS Account with administrator access
- [ ] AWS CLI configured (`aws configure`)
- [ ] Node.js 20.x installed
- [ ] Git repository access
- [ ] CreativeDrive API key
- [ ] Bynder OAuth credentials (Client ID, Client Secret, Access Token URL, API Base URL)

## Step 1: Clone and Setup

```bash
# Clone the repository
git clone <repository-url>
cd mk-dam-migration

# Install Node.js dependencies
npm install

# Set .env.local for testing
cp .env.local.template .env.local

# Set env vars in .env.local

# Verify setup
npm run test
npm run test:integration
npm run lint
npm run build
```

## Step 2: Configure Bitbucket Secrets

See BITBUCKET_SETUP.md

## Step 3: Create S3 Bucket for Lambda Packages

The CloudFormation deployment needs an S3 bucket to store Lambda deployment packages:

```bash
aws s3 mb s3://dam-migration-lambda-packages --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket dam-migration-lambda-packages \
  --versioning-configuration Status=Enabled

# Block public access
aws s3api put-public-access-block \
  --bucket dam-migration-lambda-packages \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## Step 4: Deploy Infrastructure

### Automatic Deployment (Recommended)

Simply push to the `main` branch and Bitbucket pipeline will automatically:

1. Build and test the code
2. Package Lambda functions
3. Upload to S3
4. Deploy CloudFormation stack

```bash
git checkout main
git pull
git push
```