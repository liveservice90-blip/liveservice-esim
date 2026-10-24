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
      error: "استخدم GET لاختبار التخزين"
    });
  }

  try {
    // مخزن منفصل عن الطلبات والمدفوعات.
    const store = getStore({
      name: "liveservice-storage-test"
    });

    const key = `check:${randomUUID()}`;

    const results = await Promise.all([
      store.setJSON(
        key,
        { attempt: 1 },
        { onlyIfNew: true }
      ),
      store.setJSON(
        key,
        { attempt: 2 },
        { onlyIfNew: true }
      )
    ]);

    const successfulWrites = results.filter(
      result => result?.modified === true
    ).length;

    const saved = await store.get(key, {
      type: "json"
    });

    const success =
      successfulWrites === 1 &&
      [1, 2].includes(saved?.attempt);

    return reply(success ? 200 : 500, {
      success,
      message: success
        ? "نجح اختبار التخزين ومنع الكتابة المتكررة"
        : "لم ينجح اختبار التخزين",
      attempts: 2,
      successfulWrites
    });
  } catch {
    return reply(500, {
      success: false,
      error: "تعذر إجراء اختبار التخزين"
    });
  }
};
