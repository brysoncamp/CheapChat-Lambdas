import dynamoDB from "./dynamoClient.mjs";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const removeDynamoAttribute = async (tableName, key, attributeName) => {
  return await dynamoDB.send(new UpdateCommand({
    TableName: tableName,
    Key: key,
    UpdateExpression: `REMOVE ${attributeName}`,
  }));
};
