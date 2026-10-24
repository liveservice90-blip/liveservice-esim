import { getStore } from "@netlify/blobs";

const escape = value =>
  String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]
  );

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; " +
    "base-uri 'none'; frame-ancestors 'none'"
};

function page(status, message, extra = "") {
  return new Response(
    `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport"
    content="width=device-width,initial-scale=1">
  <title>نتيجة الطلب | LiveService</title>
  <style>
    body {
      margin: 0;
      padding: 24px 16px;
      background: #f5f8f8;
      color: #183b41;
      font-family: Tahoma, Arial;
    }
    main {
      max-width: 620px;
      margin: 25px auto;
      padding: 24px;
      background: white;
      border-radius: 18px;
      line-height: 2;
      overflow-wrap: anywhere;
    }
    a { color: #087f85; }
    .button {
      display: inline-block;
      padding: 12px 20px;
      background: #087f85;
      color: white;
      border-radius: 10px;
      text-decoration: none;
    }
    code, pre {
      display: block;
      direction: ltr;
      text-align: left;
      padding: 10px;
      background: #f5f8f8;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: all;
    }
  </style>
</head>
<body>
  <main>
    <h1>LiveService eSIM</h1>
    <p>${escape(message)}</p>
    ${extra}
    <p><a href="/">العودة إلى الموقع</a></p>
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8"
      }
    }
  );
}

// فحص مؤقت يعرض أسماء الحقول وأنواعها فقط.
function shape(value, depth = 0) {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      first: depth < 3 && value.length
        ? shape(value[0], depth + 1)
        : null
    };
  }

  if (typeof value === "object") {
    if (depth >= 3) return "object";

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [
          key,
          shape(item, depth + 1)
        ])
    );
  }

  return typeof value;
}

export default async (request) => {
  if (request.method !== "GET") {
    return page(405, "طريقة الطلب غير مسموحة.");
  }

  const url = new URL(request.url);
  const orderId = url.searchParams.get("order");
  const paymentId = url.searchParams.get("paymentId");

  const uuidPattern =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  if (
    !orderId ||
    !uuidPattern.test(orderId) ||
    !paymentId ||
    paymentId.length > 250
  ) {
    return page(
      400,
      "بيانات التحقق من الدفع غير مكتملة."
    );
  }

  const orderNote =
    "<p>رقم طلبك:</p>" +
    `<code>${escape(orderId)}</code>`;

  const paymentKey =
    process.env.MYFATOORAH_API_KEY?.trim();

  const esimKey =
    process.env.ESIM_GO_API_KEY?.trim();

  if (!paymentKey) {
    return page(
      503,
      "خدمة التحقق غير متاحة حاليًا.",
      orderNote
    );
  }

  try {
    const store = getStore({
      name: "liveservice-orders"
    });

    const order = await store.get(
      `order:${orderId}`,
      { type: "json" }
    );

    if (!order) {
      return page(
        404,
        "لم يتم العثور على الطلب.",
        orderNote
      );
    }

    if (
      order.orderId !== orderId ||
      order.currency !== "SAR" ||
      typeof order.amount !== "number" ||
      !Number.isFinite(order.amount) ||
      order.amount <= 0 ||
      !Number.isSafeInteger(order.invoiceId) ||
      typeof order.bundleName !== "string" ||
      !order.bundleName
    ) {
      return page(
        409,
        "تعذر مطابقة بيانات الطلب. تواصل مع الدعم.",
        orderNote
      );
    }

    const paymentResponse = await fetch(
      "https://api-sa.myfatoorah.com/v2/GetPaymentStatus",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paymentKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          Key: paymentId,
          KeyType: "PaymentId"
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const payment = await paymentResponse.json();

    if (
      !paymentResponse.ok ||
      payment.IsSuccess !== true ||
      !payment.Data
    ) {
      return page(
        502,
        "تعذر التحقق من الدفع. احتفظ بإيصال العملية وحاول لاحقًا.",
        orderNote
      );
    }

    const invoice = payment.Data;
    const invoiceAmount = Number(invoice.InvoiceValue);

    if (
      String(invoice.InvoiceId) !==
        String(order.invoiceId) ||
      invoice.CustomerReference !== orderId ||
      !Number.isFinite(invoiceAmount) ||
      Math.abs(invoiceAmount - order.amount) > 0.001
    ) {
      return page(
        409,
        "تعذر مطابقة الفاتورة مع الطلب. تواصل مع الدعم.",
        orderNote
      );
    }

    if (invoice.InvoiceStatus !== "Paid") {
      return page(
        200,
        "لم يتم تأكيد السداد. قد تكون العملية معلّقة أو غير مكتملة.",
        orderNote
      );
    }

    await store.setJSON(
      `verified:${orderId}:${order.invoiceId}`,
      {
        orderId,
        invoiceId: order.invoiceId,
        amount: order.amount,
        currency: "SAR",
        paymentVerified: true,
        verifiedAt: new Date().toISOString()
      },
      { onlyIfNew: true }
    );

    if (!esimKey) {
      return page(
        503,
        "تم تأكيد السداد، وخدمة تسليم الشريحة غير متاحة حاليًا. لا تعِد الدفع.",
        orderNote
      );
    }

    const providerKey =
      `provider:${orderId}:${order.invoiceId}`;

    let provider = await store.get(
      providerKey,
      { type: "json" }
    );

    if (!provider) {
      if (
        process.env.ESIM_ISSUANCE_ENABLED !== "true"
      ) {
        return page(
          503,
          "تم تأكيد السداد. إصدار الشريحة غير مفعّل حاليًا؛ تواصل مع الدعم ولا تعِد الدفع.",
          orderNote
        );
      }

      // حجز دائم لمنع تكرار شراء الشريحة.
      // لا نحذفه عند انقطاع الاتصال.
      const claim = await store.setJSON(
        `issuance:${orderId}:${order.invoiceId}`,
        {
          orderId,
          invoiceId: order.invoiceId,
          bundleName: order.bundleName,
          startedAt: new Date().toISOString()
        },
        { onlyIfNew: true }
      );

      if (claim?.modified !== true) {
        return page(
          202,
          "تم تأكيد السداد وسبق بدء إصدار الشريحة. حدّث الصفحة بعد قليل؛ إذا استمرت الرسالة تواصل مع الدعم ولا تعِد الدفع.",
          orderNote
        );
      }

      // طلب شراء واحد دون إعادة محاولة تلقائية.
      const response = await fetch(
        "https://api.esim-go.com/v2.5/orders",
        {
          method: "POST",
          headers: {
            "X-API-Key": esimKey,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            type: "transaction",
            assign: true,
            order: [
              {
                type: "bundle",
                quantity: 1,
                item: order.bundleName,
                allowReassign: false
              }
            ]
          }),
          signal: AbortSignal.timeout(25000)
        }
      );

      const result = await response.json();

      provider = {
        ok: response.ok,
        result,
        receivedAt: new Date().toISOString()
      };

      await store.setJSON(
        providerKey,
        provider,
        { onlyIfNew: true }
      );
    }

    const reference = provider.result?.orderReference;

    if (
      provider.ok !== true ||
      typeof reference !== "string" ||
      !reference ||
      reference.length > 250
    ) {
      return page(
        502,
        "تم تأكيد السداد لكن إصدار الشريحة يحتاج مراجعة الدعم. لا تعِد الدفع.",
        orderNote
      );
    }

    const assignmentsUrl = new URL(
      "https://api.esim-go.com/v2.5/esims/assignments"
    );

    assignmentsUrl.searchParams.set(
      "reference",
      reference
    );

    // تنزيل QR للطلب نفسه بعد التحقق من السداد.
    if (url.searchParams.get("download") === "qr") {
      const response = await fetch(
        assignmentsUrl,
        {
          headers: {
            "X-API-Key": esimKey,
            Accept: "application/zip"
          },
          signal: AbortSignal.timeout(15000)
        }
      );

      if (!response.ok) {
        return page(
          502,
          "ملف QR غير جاهز حاليًا. عُد إلى الصفحة السابقة وحاول لاحقًا.",
          orderNote
        );
      }

      const bytes = new Uint8Array(
        await response.arrayBuffer()
      );

      if (
        bytes.length < 4 ||
        bytes.length > 5_000_000 ||
        bytes[0] !== 80 ||
        bytes[1] !== 75
      ) {
        return page(
          502,
          "تعذر تحميل ملف QR الصحيح. حاول لاحقًا.",
          orderNote
        );
      }

      return new Response(bytes, {
        headers: {
          ...headers,
          "Content-Type": "application/zip",
          "Content-Disposition":
            `attachment; filename="LiveService-${orderId}.zip"`
        }
      });
    }

    const response = await fetch(
      assignmentsUrl,
      {
        headers: {
          "X-API-Key": esimKey,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      return page(
        202,
        "تم تأكيد السداد وإرسال طلب الشريحة. بيانات التثبيت لم تجهز بعد؛ حدّث الصفحة لاحقًا ولا تعِد الدفع.",
        orderNote
      );
    }

    const details = await response.json();

    // الإضافة المؤقتة للفحص.
    // لا تعرض أي قيمة من بيانات التفعيل.
    return page(
      200,
      "تم تأكيد السداد. فحص صيغة بيانات التثبيت:",
      orderNote +
        "<pre dir=\"ltr\">" +
        escape(JSON.stringify(shape(details), null, 2)) +
        "</pre>"
    );
  } catch {
    return page(
      502,
      "تعذر إكمال الطلب حاليًا. إن تم الخصم فلا تعِد الدفع؛ احتفظ بإيصالك ورقم الطلب وتواصل مع الدعم.",
      orderNote
    );
  }
};
