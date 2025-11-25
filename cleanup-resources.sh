#!/bin/bash

# Script to clean up partially created AWS resources
# Run this script to delete resources before re-running Terraform

set -e

REGION="us-east-1"
ENVIRONMENT="prod"

echo "Starting cleanup of AWS resources for environment: $ENVIRONMENT"
echo "Region: $REGION"
echo ""

# Delete DynamoDB table
echo "Deleting DynamoDB table..."
aws dynamodb delete-table \
  --table-name dam-migration-tracker-$ENVIRONMENT \
  --region $REGION \
  2>/dev/null && echo "✓ DynamoDB table deleted" || echo "✗ DynamoDB table not found or already deleted"

# Delete Secrets Manager secrets
echo "Deleting Secrets Manager secrets..."
aws secretsmanager delete-secret \
  --secret-id dam-migration-creativedrive-$ENVIRONMENT \
  --force-delete-without-recovery \
  --region $REGION \
  2>/dev/null && echo "✓ CreativeDrive secret deleted" || echo "✗ CreativeDrive secret not found or already deleted"

aws secretsmanager delete-secret \
  --secret-id dam-migration-bynder-$ENVIRONMENT \
  --force-delete-without-recovery \
  --region $REGION \
  2>/dev/null && echo "✓ Bynder secret deleted" || echo "✗ Bynder secret not found or already deleted"

# Delete IAM role policies
echo "Deleting IAM role policies..."
aws iam delete-role-policy \
  --role-name dam-migration-ingest-lambda-$ENVIRONMENT \
  --policy-name dam-migration-ingest-lambda-policy-$ENVIRONMENT \
  2>/dev/null && echo "✓ Ingest Lambda policy deleted" || echo "✗ Ingest Lambda policy not found or already deleted"

aws iam delete-role-policy \
  --role-name dam-migration-processor-lambda-$ENVIRONMENT \
  --policy-name dam-migration-processor-lambda-policy-$ENVIRONMENT \
  2>/dev/null && echo "✓ Processor Lambda policy deleted" || echo "✗ Processor Lambda policy not found or already deleted"

# Delete IAM roles
echo "Deleting IAM roles..."
aws iam delete-role \
  --role-name dam-migration-ingest-lambda-$ENVIRONMENT \
  2>/dev/null && echo "✓ Ingest Lambda role deleted" || echo "✗ Ingest Lambda role not found or already deleted"

aws iam delete-role \
  --role-name dam-migration-processor-lambda-$ENVIRONMENT \
  2>/dev/null && echo "✓ Processor Lambda role deleted" || echo "✗ Processor Lambda role not found or already deleted"

# Delete S3 bucket (only if empty)
echo "Deleting S3 bucket..."
aws s3 rb s3://dam-migration-assets-$ENVIRONMENT \
  --region $REGION \
  2>/dev/null && echo "✓ S3 bucket deleted" || echo "✗ S3 bucket not found or already deleted"

echo ""
echo "Cleanup complete! You can now run Terraform apply again."
