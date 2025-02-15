import OpenAI from "openai";

export const getOpenAIResponse = async (apiKey, model, messages) => {
  const openai = new OpenAI({ apiKey });

  return openai.chat.completions.create({
    model: model,
    messages: messages,
    stream: true,
    stream_options: { include_usage: true },
  });
};

export const processOpenAIStream = async (response, apiGateway, connectionId) => {
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

    const text = chunk.choices?.[0]?.delta?.content || "";
    if (text) {
      await apiGateway.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ text }),
      }));
      fullResponse += text;
    }
  }

  return { promptTokens, completionTokens, receivedUsage, fullResponse };
};