import { GoogleGenAI } from "@google/genai";

export async function generateMaiinStrategy(strategyContext) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY belum diisi di file .env");
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  const prompt = `
You are an AI marketing strategy assistant for Maiin Gandaria.

Maiin Gandaria is a sports venue business. The system goal is to improve:
- Revenue
- Occupancy
- Promotion efficiency
- Customer retention

Important rules:
- Use only summarized data provided by the backend.
- Do not request or mention personal customer data.
- Do not use customer names, emails, or phone numbers.
- Generate practical and actionable strategy cards.
- Output must be suitable for a marketing dashboard.

Selected campaign filters:
${JSON.stringify(strategyContext.selected_filters, null, 2)}

Customer segment summary:
${JSON.stringify(strategyContext.customer_segment_summary, null, 2)}

Business context:
${JSON.stringify(strategyContext.business_context, null, 2)}

Promotion context:
${JSON.stringify(strategyContext.promotion_context, null, 2)}

Generate exactly 2 strategy cards.

Return valid JSON only with this structure:
{
  "strategy_cards": [
    {
      "title": "",
      "objective": "",
      "action_plan": ["", "", ""],
      "incentive": "",
      "copywriting_channel": "",
      "ready_to_use_copywriting": "",
      "kpi_to_monitor": ["", "", ""]
    }
  ]
}
`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: prompt,
    config: {
      temperature: 0.7,
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
    },
  });

  const text = response.text;

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw_response: text,
    };
  }
}