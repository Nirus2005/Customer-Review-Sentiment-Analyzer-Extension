export async function generateWithCloudApi(prompt, port, requestId, aiProvider, aiApiKey, aiModelName, aiBaseUrl) {
  let endpoint = "";
  let headers = {
    "Content-Type": "application/json",
  };
  let body = {};
  
  // Format the prompt text from the messages array
  const systemPrompt = prompt.find(p => p.role === "system")?.content || "";
  const userPrompt = prompt.find(p => p.role === "user")?.content || "";
  const fullPromptText = `${systemPrompt}\n\n${userPrompt}`;

  if (aiProvider === "gemini") {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${aiModelName}:streamGenerateContent?key=${aiApiKey}`;
    body = {
      contents: [
        {
          role: "user",
          parts: [{ text: fullPromptText }]
        }
      ]
    };
  } else if (aiProvider === "openai" || aiProvider === "custom") {
    endpoint = aiProvider === "openai" ? "https://api.openai.com/v1/chat/completions" : `${aiBaseUrl}/chat/completions`;
    headers["Authorization"] = `Bearer ${aiApiKey}`;
    body = {
      model: aiModelName,
      messages: prompt,
      stream: true,
    };
  } else {
    throw new Error(`Unsupported AI Provider: ${aiProvider}`);
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Error ${response.status}: ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let accumulatedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      
      // Basic extraction of text based on provider
      let newText = "";
      if (aiProvider === "gemini") {
        // Gemini streaming chunk format isn't strictly SSE, it's a JSON array often.
        // We'll do a simple regex or JSON parse to extract text parts.
        const matches = chunk.match(/"text":\s*"([^"]+)"/g);
        if (matches) {
          for (const match of matches) {
            const str = match.substring(9, match.length - 1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
            newText += str;
          }
        }
      } else {
        // OpenAI SSE format
        const lines = chunk.split("\n").filter(l => l.trim() !== "");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.substring(6).trim();
            if (dataStr === "[DONE]") break;
            try {
              const data = JSON.parse(dataStr);
              if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                newText += data.choices[0].delta.content;
              }
            } catch (e) {
              // ignore parse errors for partial chunks
            }
          }
        }
      }

      if (newText) {
        accumulatedText += newText;
        try {
          port.postMessage({
            type: "TOKEN",
            requestId,
            token: newText,
            text: accumulatedText,
          });
        } catch {
          // Port closed
          return;
        }
      }
    }

    try {
      port.postMessage({
        type: "DONE",
        requestId,
        text: accumulatedText,
      });
    } catch {}
  } catch (error) {
    try {
      port.postMessage({
        type: "ERROR",
        requestId,
        error: error.message,
      });
    } catch {}
  }
}

export async function embedWithCloudApi(texts, aiProvider, aiApiKey, aiBaseUrl) {
  let endpoint = "";
  let headers = { "Content-Type": "application/json" };
  let body = {};

  if (aiProvider === "gemini") {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${aiApiKey}`;
    body = {
      requests: texts.map(text => ({
        model: "models/text-embedding-004",
        content: { parts: [{ text }] }
      }))
    };
  } else if (aiProvider === "openai" || aiProvider === "custom") {
    endpoint = aiProvider === "openai" ? "https://api.openai.com/v1/embeddings" : `${aiBaseUrl}/embeddings`;
    headers["Authorization"] = `Bearer ${aiApiKey}`;
    body = {
      model: "text-embedding-3-small", // default model for OpenAI
      input: texts
    };
  } else {
    throw new Error(`Unsupported AI Provider for embeddings: ${aiProvider}`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding API Error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  if (aiProvider === "gemini") {
    return data.embeddings.map(e => e.values);
  } else {
    // OpenAI format
    return data.data.map(d => d.embedding);
  }
}

export async function classifySentimentWithCloudApi(texts, aiProvider, aiApiKey, aiModelName, aiBaseUrl) {
  let endpoint = "";
  let headers = { "Content-Type": "application/json" };
  let body = {};

  const promptText = `Classify the sentiment of the following texts. You must reply with ONLY a valid JSON array of strings, where each string is exactly "Positive", "Negative", or "Mixed". Do not include any markdown formatting, backticks, or other text. There should be exactly ${texts.length} strings in the array. \n\nTexts:\n${JSON.stringify(texts)}`;

  if (aiProvider === "gemini") {
    // Use the user's configured model
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${aiModelName}:generateContent?key=${aiApiKey}`;
    body = {
      contents: [{ role: "user", parts: [{ text: promptText }] }]
    };
  } else if (aiProvider === "openai" || aiProvider === "custom") {
    endpoint = aiProvider === "openai" ? "https://api.openai.com/v1/chat/completions" : `${aiBaseUrl}/chat/completions`;
    headers["Authorization"] = `Bearer ${aiApiKey}`;
    body = {
      model: aiModelName || "gpt-4o-mini",
      messages: [{ role: "user", content: promptText }]
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Sentiment API Error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  let resultText = "";

  if (aiProvider === "gemini") {
    resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  } else {
    resultText = data.choices?.[0]?.message?.content || "[]";
  }

  // Clean the text to ensure it parses as JSON
  resultText = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
  
  try {
    const jsonResult = JSON.parse(resultText);
    if (Array.isArray(jsonResult)) {
      // Return objects like the local model does: [{ label: 'POSITIVE', score: 0.99 }]
      return jsonResult.map(label => ({
        label: label.toUpperCase(),
        score: 0.99 // dummy high score since LLM is confident
      }));
    }
  } catch (e) {
    console.error("Failed to parse JSON sentiment:", resultText);
  }

  // Fallback if parsing fails or returns invalid format
  return texts.map(() => ({ label: 'MIXED', score: 0.5 }));
}
