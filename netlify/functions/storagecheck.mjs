import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

export default async (request) => {
  const reply = (status, data) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });

  if (request.method !== "GET") {
    return reply(405, { error: "GET only" });
  }

  let store;
  let key;

  try {
    store = getStore({
      name: "liveservice-storage-checks"
    });

    key = `atomic-check:${randomUUID()}`;

    // محاولتان متزامنتان لحجز المفتاح نفسه.
    const attempts = await Promise.all(
      ["first", "second"].map(async (owner) => {
        const result = await store.setJSON(
          key,
          { owner },
          { onlyIfNew: true }
        );

        if (typeof result?.modified !== "boolean") {
          throw new Error("Unexpected write result");
        }

        return {
          owner,
          modified: result.modified
        };
      })
    );

    const winners = attempts.filter(
      item => item.modified === true
    );

    if (winners.length !== 1) {
      throw new Error("Atomic write check failed");
    }

    const saved = await store.get(key, {
      type: "json"
    });

    if (saved?.owner !== winners[0].owner) {
      throw new Error("Read verification failed");
    }

    return reply(200, {
      success: true,
      message: "نجح اختبار التخزين ومنع الكتابة المتكررة",
      attempts: attempts.length,
      successfulWrites: winners.length
    });
  } catch (error) {
    return reply(500, {
      success: false,
      error: "تعذر اجتياز اختبار منع الكتابة المتكررة",
      type: error?.name || "Error"
    });
  } finally {
    if (store && key) {
      await store.delete(key).catch(() => {});
    }
  }
};
