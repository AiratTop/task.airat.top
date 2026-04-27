import { GoogleGenAI, Type } from "@google/genai";
import { normalizeTags } from "../lib/utils";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function analyzeTask(taskTitle: string, taskDescription: string = ""): Promise<{ tags: string[] }> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Analyze this task: "${taskTitle}". ${taskDescription ? `Description: ${taskDescription}` : ""}. 
      Generate 1-3 short, relevant tags for this task. Tags must be lowercase kebab-case with no spaces.
      Return only a JSON object with "tags" (array of strings).`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ["tags"],
        },
      },
    });

    const result = JSON.parse(response.text || "{}");
    
    return {
      tags: Array.isArray(result.tags) ? normalizeTags(result.tags) : [],
    };
  } catch (error) {
    console.error("Error analyzing task:", error);
    return { tags: [] };
  }
}

export async function decomposeTask(taskTitle: string, taskDescription: string = ""): Promise<string[]> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Break down this task into 3-5 small, actionable subtasks: "${taskTitle}". ${taskDescription ? `Description: ${taskDescription}` : ""}. Return only a JSON array of strings.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
    });

    const subtasks = JSON.parse(response.text || "[]");
    return Array.isArray(subtasks) ? subtasks : [];
  } catch (error) {
    console.error("Error decomposing task:", error);
    return [];
  }
}
