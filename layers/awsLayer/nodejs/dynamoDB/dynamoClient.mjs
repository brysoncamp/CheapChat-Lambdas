import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const dynamoDB = new DynamoDBClient({});

export default dynamoDB;