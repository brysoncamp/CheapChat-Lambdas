import { encoding_for_model } from "tiktoken";

export const countTokens = (text, model = "gpt-4o") => {
  const encoder = encoding_for_model(model);
  const tokenCount = encoder.encode(text).length + 1;
  encoder.free();
  console.log("Count tokens:", tokenCount);
  return tokenCount;
};

export const countTokensForMessages = (messages, model = "gpt-4o") => {
  const encoder = encoding_for_model(model);
  let tokenCount = 2;

  messages.forEach(({ role, content }) => {
    tokenCount += 4;
    tokenCount += encoder.encode(role).length;
    tokenCount += encoder.encode(content).length;
  });

  console.log("Count tokens for messages:", tokenCount);
  return tokenCount;
};