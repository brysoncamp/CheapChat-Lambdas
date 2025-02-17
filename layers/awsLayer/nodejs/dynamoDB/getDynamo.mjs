import dynamoDB from "./dynamoClient.mjs";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

export const getDynamoItem = async (tableName, key) => {
  const result = await dynamoDB.send(new GetCommand({
    TableName: tableName,
    Key: key,
  }));
  
  return result.Item ?? null;
};
