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
    return reply(405, {
      error: "استخدم GET لفحص التخزين"
    });
  }

  let store;
  let key;

  try {
    store = getStore({
      name: "liveservice-storage-checks"
    });

    key = randomUUID();

    await store.setJSON(key, {
      test: key
    });

    const saved = await store.get(key, {
      type: "json"
    });

    if (saved?.test !== key) {
      throw new Error("Storage check failed");
    }

    return reply(200, {
      message: "تم التحقق من حفظ البيانات وقراءتها بنجاح"
    });
  } catch (error) {
    return reply(500, {
      error: "تعذر التحقق من التخزين",
      type: error?.name || "Error",
      code: error?.code || "UNKNOWN"
    });
  } finally {
    if (store && key) {
      await store.delete(key).catch(() => {});
    }
  }
};
