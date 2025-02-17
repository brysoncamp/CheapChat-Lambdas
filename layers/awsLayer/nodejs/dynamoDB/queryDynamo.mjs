import dynamoDB from "./dynamoClient.mjs";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

export const queryLatestDynamo = async (tableName, keyCondition, values, limit) => {
  const result = await dynamoDB.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeValues: values,
    ScanIndexForward: false,
    Limit: limit
  }));

  return result.Items ?? [];
};