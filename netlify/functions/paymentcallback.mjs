import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";
import QRCode from "qrcode";

const SITE_URL = "https://liveservice-esim.netlify.app";

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

const validEmail = value =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
  !/[\r\n]/.test(value);

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; " +
    "base-uri 'none'; frame-ancestors 'none'"
};

function giftCard(order) {
  if (!order.gift) return "";

  return `
    <section style="
      padding:24px;
      background:#fffbf1;
      border:1px solid #dca747;
      border-radius:16px;
      margin:20px 0;
    ">
      <h2>🎁 هدية إنترنت لك</h2>
      <p>إلى: ${escape(order.gift.recipientName)}</p>
      <p>من: ${escape(order.customerName)}</p>
      <p>الباقة: ${escape(
        order.description || order.bundleName
      )}</p>
      <p style="white-space:pre-wrap">${escape(
        order.gift.message
      )}</p>
      <p>مع أطيب الأمنيات برحلة سعيدة — خدمة مباشرة</p>
    </section>
  `;
}

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
    code {
      display: block;
      direction: ltr;
      text-align: left;
      padding: 10px;
      background: #f5f8f8;
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

// فشل البريد لا يمنع ظهور بيانات الشريحة.
// لا نعيد المحاولة تلقائيًا بعد بدء الإرسال.
async function sendDeliveryEmail({
  store,
  order,
  sim,
  resultUrl,
  downloadUrl,
  imageUrl
}) {
  const recipientEmail =
    order.gift?.delivery === "email"
      ? order.gift.recipientEmail
      : order.customerEmail;

  const recipientName =
    order.gift?.delivery === "email"
      ? order.gift.recipientName
      : order.customerName;

  const key = `email:${order.orderId}:${order.invoiceId}`;
  let transporter;

  try {
    const previous = await store.get(key, {
      type: "json"
    });

    if (previous?.status === "sent") {
      return "قبل خادم البريد رسالة بيانات الشريحة. تحقق من الوارد والبريد غير المرغوب فيه.";
    }

    if (previous) {
      return "سبق بدء محاولة إرسال البريد. إذا لم تصلك الرسالة، احتفظ ببيانات الشريحة الظاهرة هنا وتواصل مع الدعم.";
    }

    const host = process.env.SMTP_HOST?.trim();
    const port = Number(process.env.SMTP_PORT || "465");
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM?.trim();

    if (
      !host ||
      ![465, 587, 25].includes(port) ||
      !user ||
      !pass ||
      !validEmail(from) ||
      !validEmail(recipientEmail)
    ) {
      return "بيانات الشريحة جاهزة هنا، لكن إعدادات إرسال البريد أو عنوان المستلم غير مكتملة.";
    }

    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: {
        user,
        pass
      },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: {
        minVersion: "TLSv1.2"
      }
    });

    const claim = await store.setJSON(
      key,
      {
        status: "sending",
        orderId: order.orderId,
        invoiceId: order.invoiceId,
        startedAt: new Date().toISOString()
      },
      { onlyIfNew: true }
    );

    if (claim?.modified !== true) {
      return "سبق بدء محاولة إرسال البريد. تحقق من بريدك، واحتفظ ببيانات الشريحة الظاهرة هنا.";
    }

    const description =
      order.description || order.bundleName;

    const text = [
      "LiveService eSIM",
      "",
      `مرحبًا ${recipientName || "بك"}،`,
      "تم تأكيد السداد وبيانات شريحتك جاهزة.",
      ...(order.gift
        ? [
            `هدية إلى: ${order.gift.recipientName}`,
            `من: ${order.customerName}`,
            order.gift.message
          ]
        : []),
      "",
      `رقم الطلب: ${order.orderId}`,
      `الباقة: ${description}`,
      `ICCID: ${sim.iccid}`,
      "",
      "بيانات التثبيت اليدوي:",
      `SM-DP+: ${sim.smdpAddress}`,
      `رمز التفعيل: ${sim.matchingId}`,
      "",
      "فتح صورة QR وحفظها في الصور:",
      imageUrl,
      "",
      "إضافة الشريحة على الآيفون:",
      "اتصل بالواي فاي وافتح صورة QR المحفوظة في تطبيق الصور، ثم اضغط مطولًا على الرمز. إذا ظهر خيار إضافة eSIM، اضغط عليه واتبع التعليمات.",
      "إذا لم يظهر الخيار: الإعدادات ← خلوي ← إضافة eSIM ← استخدام رمز QR ← إدخال التفاصيل يدويًا. استخدم عنوان SM-DP+ ورمز التفعيل الواردين في هذه الرسالة.",
      "",
      "تحميل ملف QR المضغوط:",
      downloadUrl,
      "",
      "صفحة بيانات الشريحة:",
      resultUrl,
      "",
      "احتفظ بهذه البيانات والروابط في مكان خاص.",
      "لا تشارك رمز التفعيل أو رابط الشريحة مع الآخرين.",
      "",
      "للدعم: info@liveservice-sa.com"
    ].join("\n");

    const info = await transporter.sendMail({
      from: {
        name: "LiveService eSIM",
        address: from
      },
      to: {
        address: recipientEmail.trim()
      },
      subject: order.gift
        ? "وصلتك هدية إنترنت | LiveService eSIM"
        : "بيانات شريحتك الإلكترونية | LiveService eSIM",
      messageId:
        `<esim-${order.orderId}-${order.invoiceId}@liveservice-sa.com>`,
      text,
      html: `
        <!doctype html>
        <html lang="ar" dir="rtl">
        <body style="
          margin:0;
          padding:20px;
          background:#f5f8f8;
          font-family:Tahoma,Arial;
          color:#183b41;
        ">
          <main style="
            max-width:620px;
            margin:auto;
            padding:24px;
            background:white;
            border-radius:16px;
            line-height:2;
            overflow-wrap:anywhere;
          ">
            <h1 style="color:#087f85">LiveService eSIM</h1>
            <p>مرحبًا ${escape(recipientName || "بك")}،</p>
            <p>تم تأكيد السداد وبيانات شريحتك جاهزة.</p>

            ${giftCard(order)}

            <p>رقم الطلب:</p>
            <p dir="ltr">${escape(order.orderId)}</p>

            <p>الباقة: ${escape(description)}</p>

            <p>رقم الشريحة ICCID:</p>
            <p dir="ltr">${escape(sim.iccid)}</p>

            <p>
              <a href="${escape(downloadUrl)}"
                style="
                  display:inline-block;
                  padding:12px 20px;
                  background:#087f85;
                  color:white;
                  border-radius:10px;
                  text-decoration:none;
                ">
                تحميل ملف QR
              </a>
            </p>

            <p>
              <a href="${escape(imageUrl)}"
                style="
                  display:inline-block;
                  padding:12px 20px;
                  background:#087f85;
                  color:white;
                  border-radius:10px;
                  text-decoration:none;
                ">
                فتح وحفظ صورة QR
              </a>
            </p>

            <p>
              لحفظ الرمز: افتح الصورة ثم اضغط عليها
              مطولًا واختر «حفظ في الصور».
            </p>

            <p>
              <strong>إضافة الشريحة على الآيفون:</strong>
              اتصل بالواي فاي، وافتح صورة QR من تطبيق
              «الصور»، ثم اضغط مطولًا على الرمز.
              إذا ظهر خيار «إضافة eSIM»، اضغط عليه
              واتبع التعليمات.
            </p>

            <p>
              إذا لم يظهر الخيار:
              الإعدادات ← خلوي ← إضافة eSIM ← استخدام رمز QR
              ← إدخال التفاصيل يدويًا.
              انسخ عنوان SM-DP+ ورمز التفعيل الموضحين أدناه.
            </p>

            <p>وللتثبيت اليدوي استخدم البيانات التالية:</p>

            <p>عنوان SM-DP+:</p>
            <p dir="ltr">${escape(sim.smdpAddress)}</p>

            <p>رمز التفعيل:</p>
            <p dir="ltr">${escape(sim.matchingId)}</p>

            <p>
              <a href="${escape(resultUrl)}">
                عرض صفحة بيانات الشريحة
              </a>
            </p>

            <p>
              احتفظ بهذه البيانات والروابط في مكان خاص،
              ولا تشاركها مع الآخرين.
            </p>

            <p>للدعم: info@liveservice-sa.com</p>
          </main>
        </body>
        </html>
      `
    });

    if (
      !Array.isArray(info.accepted) ||
      !info.accepted.length
    ) {
      throw new Error("SMTP did not accept recipient");
    }

    await store.setJSON(key, {
      status: "sent",
      orderId: order.orderId,
      invoiceId: order.invoiceId,
      sentAt: new Date().toISOString()
    });

    return "قبل خادم البريد رسالة بيانات الشريحة. تحقق من الوارد والبريد غير المرغوب فيه.";
  } catch {
    // نحتفظ بالحجز لمنع تكرار الرسالة عند تحديث الصفحة.
    return "تعذر تأكيد إرسال البريد. بيانات شريحتك متاحة هنا؛ احفظها وتواصل مع الدعم إذا لم تصلك الرسالة.";
  } finally {
    if (transporter) {
      transporter.close();
    }
  }
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
      name: "liveservice-orders",
      consistency: "strong"
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
      String(invoice.InvoiceId) !== String(order.invoiceId) ||
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
      if (process.env.ESIM_ISSUANCE_ENABLED !== "true") {
        return page(
          503,
          "تم تأكيد السداد. إصدار الشريحة غير مفعّل حاليًا؛ تواصل مع الدعم ولا تعِد الدفع.",
          orderNote
        );
      }

      // حجز دائم لمنع تكرار شراء الشريحة.
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

    const sims = Array.isArray(details)
      ? details
      : [details];

    const rawSim = sims.length === 1
      ? sims[0]
      : null;

    const sim =
      rawSim && typeof rawSim === "object"
        ? {
            ...rawSim,
            smdpAddress:
              typeof rawSim.smdpAddress === "string" &&
              rawSim.smdpAddress.trim()
                ? rawSim.smdpAddress.trim()
                : typeof rawSim.rspUrl === "string"
                  ? rawSim.rspUrl.trim()
                  : ""
          }
        : null;

    if (
      !sim ||
      typeof sim.iccid !== "string" ||
      !sim.iccid ||
      typeof sim.smdpAddress !== "string" ||
      !sim.smdpAddress ||
      typeof sim.matchingId !== "string" ||
      !sim.matchingId
    ) {
      return page(
        202,
        "تم تأكيد السداد، وننتظر بيانات تثبيت الشريحة. إذا استمرت الرسالة تواصل مع الدعم ولا تعِد الدفع.",
        orderNote
      );
    }

    // توليد صورة QR بعد التحقق من الدفع وبيانات الشريحة.
    if (url.searchParams.get("download") === "image") {
      const image = await QRCode.toBuffer(
        `LPA:1$${sim.smdpAddress}$${sim.matchingId}`,
        {
          type: "png",
          width: 1024,
          margin: 4,
          errorCorrectionLevel: "M"
        }
      );

      return new Response(new Uint8Array(image), {
        headers: {
          ...headers,
          "Content-Type": "image/png",
          "Content-Disposition":
            `inline; filename="LiveService-${orderId}.png"`
        }
      });
    }

    await store.setJSON(
      `delivery:${orderId}:${order.invoiceId}`,
      {
        orderId,
        reference,
        iccid: sim.iccid,
        preparedAt: new Date().toISOString()
      },
      { onlyIfNew: true }
    );

    const resultUrl = new URL(
      "/.netlify/functions/paymentcallback",
      SITE_URL
    );

    resultUrl.searchParams.set("order", orderId);
    resultUrl.searchParams.set("paymentId", paymentId);

    const downloadUrl = new URL(resultUrl);
    downloadUrl.searchParams.set("download", "qr");

    const imageUrl = new URL(resultUrl);
    imageUrl.searchParams.set("download", "image");

    const emailMessage = await sendDeliveryEmail({
      store,
      order,
      sim,
      resultUrl: resultUrl.toString(),
      downloadUrl: downloadUrl.toString(),
      imageUrl: imageUrl.toString()
    });

    return page(
      200,
      "تم تأكيد سداد طلبك، وبيانات تثبيت شريحتك جاهزة.",
      `
        ${orderNote}
        ${giftCard(order)}

        <p>
          الباقة:
          ${escape(order.description || order.bundleName)}
        </p>

        <p>رقم الشريحة ICCID:</p>
        <code>${escape(sim.iccid)}</code>

        <p>
          <a class="button"
            href="${escape(downloadUrl.toString())}">
            تحميل ملف QR
          </a>
        </p>

        <p>
          <a class="button"
            href="${escape(imageUrl.toString())}">
            فتح وحفظ صورة QR
          </a>
        </p>

        <p>
          لحفظ الرمز في الاستوديو:
          افتح الصورة، ثم اضغط عليها مطولًا
          واختر «حفظ في الصور».
        </p>

        <h2>إضافة الشريحة على الجهاز</h2>

        <ol>
          <li>اتصل بالواي فاي وافتح تطبيق «الصور».</li>
          <li>افتح صورة QR المحفوظة واضغط مطولًا على الرمز.</li>
          <li>
            إذا ظهر خيار «إضافة eSIM»،
            اضغط عليه واتبع تعليمات التثبيت.
          </li>
        </ol>

        <p>
          إذا لم يظهر الخيار:
          الإعدادات ← خلوي ← إضافة eSIM ← استخدام رمز QR
          ← إدخال التفاصيل يدويًا.
          انسخ عنوان SM-DP+ ورمز التفعيل الموضحين أدناه.
        </p>

        <p>
          ويمكنك فتح الملف المضغوط للوصول إلى صورة QR.
          وللتثبيت اليدوي استخدم البيانات التالية
          في إعدادات إضافة eSIM:
        </p>

        <p>عنوان SM-DP+:</p>
        <code>${escape(sim.smdpAddress)}</code>

        <p>رمز التفعيل:</p>
        <code>${escape(sim.matchingId)}</code>

        <p>${escape(emailMessage)}</p>

        <p>
          احفظ رابط هذه الصفحة وبيانات الشريحة
          في مكان خاص، ولا تشاركها مع الآخرين.
        </p>

        <p>للدعم: info@liveservice-sa.com</p>
      `
    );
  } catch {
    return page(
      502,
      "تعذر إكمال الطلب حاليًا. إن تم الخصم فلا تعِد الدفع؛ احتفظ بإيصالك ورقم الطلب وتواصل مع الدعم.",
      orderNote
    );
  }
};
