import dynamoDB from "./dynamoClient.mjs";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

export const putDynamoItem = async (tableName, item) => {
  await dynamoDB.send(new PutCommand({
    TableName: tableName,
    Item: item
  }));
}