import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsManager = new SecretsManagerClient({});
let cachedApiKey = null;

export const getOpenAIKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  
  const data = await secretsManager.send(new GetSecretValueCommand({ SecretId: "OpenAISecrets" }));
  cachedApiKey = JSON.parse(data.SecretString).OPENAI_API_KEY;

  return cachedApiKey;
};