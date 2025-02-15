import { encoding_for_model } from "tiktoken";

const countTokens = (text, model) => {
  const encoder = encoding_for_model(model);
  const tokenCount = encoder.encode(text).length + 1;
  encoder.free();
  return tokenCount;
};

const countTokensForMessages = (messages, model) => {
  const encoder = encoding_for_model(model);
  let tokenCount = 2;

  messages.forEach(({ role, content }) => {
    tokenCount += 4;
    tokenCount += encoder.encode(role).length;
    tokenCount += encoder.encode(content).length;
  });

  return tokenCount;
};

const modelCosts = {
  "gpt-4o": { "input": 0.000005, "output": 0.00002 },
  "gpt-4o-mini": { "input": 0.00000015, "output": 0.0000006 },
  "o1-mini": { "input": 0.0000022, "output": 0.0000088 },
  "o3-mini": { "input": 0.0000022, "output": 0.0000088 },
  "chatgpt-4o-latest": { "input": 0.00001, "output": 0.00003 },
  "gpt-4-turbo": { "input": 0.00002, "output": 0.00006 },
  "gpt-4": { "input": 0.00006, "output": 0.00012 },
  "gpt-3.5-turbo": { "input": 0.000001, "output": 0.000003 }
};

export const calculateCost = (promptTokens, completionTokens, model) => {
  const priceData = modelCosts[action];
  if (!priceData) throw new Error(`Unknown model: ${model}`);

  const unroundedCost = (promptTokens * priceData.input) + (completionTokens * priceData.output);
  return Number(unroundedCost.toFixed(8));
}

export const estimateCost = (messages, response, model) => {
  const promptTokens = countTokensForMessages(messages, model);
  const completionTokens = countTokens(response, model);

  return calculateCost(promptTokens, completionTokens, model);
};