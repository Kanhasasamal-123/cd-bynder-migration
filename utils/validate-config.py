import boto3

# Replace with your actual region if not set in 'aws configure'
dynamodb = boto3.resource('dynamodb', region_name='us-east-1') 
table_name = 'YourTableName' # Replace with your table name

try:
    table = dynamodb.Table(table_name)
    # Just check if table status exists to verify access
    print(f"Connection Successful! Table status: {table.table_status}")
    print(f"Item Count (approx): {table.item_count}")
except Exception as e:
    print(f"Error: {e}")