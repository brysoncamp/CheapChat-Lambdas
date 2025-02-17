import OpenAI from "openai";
import { sendMessage } from "/opt/nodejs/apiGateway.mjs";
import { removeDynamoAttribute } from "/opt/nodejs/dynamoDB/updateDynamo.mjs";

export const getOpenAIResponse = async (apiKey, model, messages) => {
  const openai = new OpenAI({ apiKey });

  return openai.chat.completions.create({
    model: model,
    messages: messages,
    stream: true,
    stream_options: { include_usage: true },
  });
};

export const processOpenAIStream = async (response, connectionId, statusFlags) => {
  let promptTokens = 0;
  let completionTokens = 0;
  let receivedUsage = false;
  let fullResponse = "";

  for await (const chunk of response) {
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
      receivedUsage = true;
    }

    if (statusFlags.timeoutTriggered || statusFlags.isCanceled) {
      const message = statusFlags.isCanceled ? { canceled: true } : { timeout: true };
      sendMessage(connectionId, message);

      if (statusFlags.isCanceled) await removeDynamoAttribute(CONNECTIONS_TABLE, { sessionId }, "canceled");
      
      break;
    }

    const text = chunk.choices?.[0]?.delta?.content || "";
    if (text) {
      sendMessage(connectionId, { text });
      fullResponse += text;
    }
  }

  return { promptTokens, completionTokens, receivedUsage, fullResponse };
};