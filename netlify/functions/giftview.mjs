import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import QRCode from "qrcode";

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
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy":
    "default-src 'none'; " +
    "img-src 'self' data:; " +
    "style-src 'unsafe-inline'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none'"
};

function page(status, body) {
  return new Response(
    `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">

  <meta name="viewport"
    content="width=device-width,initial-scale=1">

  <title>هدية إنترنت | خدمة مباشرة</title>

  <style>
    body {
      margin: 0;
      padding: 24px 16px;
      background: #f5f8f8;
      color: #183b41;
      font: 18px/1.8 Tahoma, Arial;
    }

    main {
      max-width: 620px;
      margin: auto;
      background: #fff;
      padding: 24px;
      border-radius: 20px;
    }

    h1 {
      color: #087f85;
    }

    section {
      background: #fffbf1;
      border: 1px solid #dca747;
      border-radius: 16px;
      padding: 20px;
    }

    img {
      display: block;
      max-width: 100%;
      width: 300px;
      margin: 20px auto;
    }

    code {
      display: block;
      direction: ltr;
      text-align: left;
      overflow-wrap: anywhere;
      background: #f5f8f8;
      padding: 12px;
    }

    a {
      color: #087f85;
    }

    p {
      overflow-wrap: anywhere;
    }

    .back-button {
      display: block;
      margin-top: 24px;
      padding: 12px 20px;
      border-radius: 12px;
      background: #087f85;
      color: #fff;
      text-align: center;
      text-decoration: none;
    }
  </style>
</head>

<body>
  <main>
    ${body}

    <a class="back-button" href="/">
      الرجوع إلى الموقع
    </a>
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

export default async request => {
  if (request.method !== "GET") {
    return page(405, "طريقة الطلب غير مسموحة.");
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return page(404, "رابط الهدية غير صحيح.");
  }

  try {
    const store = getStore({
      name: "liveservice-orders",
      consistency: "strong"
    });

    const digest = createHash("sha256")
      .update(token)
      .digest("hex");

    const gift = await store.get(
      `gift-share:${digest}`,
      { type: "json" }
    );

    if (
      !gift ||
      !gift.smdpAddress ||
      !gift.matchingId
    ) {
      return page(
        404,
        "الهدية غير متاحة. تواصل مع مرسل الهدية."
      );
    }

    const qr = await QRCode.toDataURL(
      `LPA:1$${gift.smdpAddress}$${gift.matchingId}`,
      {
        width: 600,
        margin: 4,
        errorCorrectionLevel: "M"
      }
    );

    return page(
      200,
      `
        <h1 dir="ltr">LiveService eSIM</h1>

        <section>
          <h2>🎁 هدية إنترنت لك</h2>

          <p>إلى: ${escape(gift.recipientName)}</p>

          <p>من: ${escape(gift.senderName)}</p>

          <p>الباقة: ${escape(gift.bundle)}</p>

          <p style="white-space:pre-wrap">${escape(gift.message)}</p>

          <p>
            مع أطيب الأمنيات برحلة سعيدة — خدمة مباشرة
          </p>
        </section>

        <h2>باركود تثبيت الشريحة</h2>

        <img
          src="${escape(qr)}"
          alt="رمز QR لتثبيت الشريحة"
        >

        <p>
          لحفظ الرمز، اضغط على الصورة مطولًا
          واختر حفظ الصورة.
        </p>

        <h2>إضافة الشريحة على الجهاز</h2>

        <p>
          اتصل بالواي فاي.
          من إعدادات الهاتف افتح خلوي أو مدير شرائح SIM،
          ثم إضافة eSIM، وامسح الرمز من جهاز آخر
          أو اختر صورته من المعرض إذا كان جهازك يدعم ذلك.
        </p>

        <p>
          للتثبيت اليدوي، اختر إدخال التفاصيل يدويًا
          واستخدم البيانات التالية:
        </p>

        <p>عنوان SM-DP+:</p>

        <code>${escape(gift.smdpAddress)}</code>

        <p>رمز التفعيل:</p>

        <code>${escape(gift.matchingId)}</code>

        <p>
          الرابط خاص بك؛ احتفظ به ولا تنشره.
          لا تحذف الشريحة بعد تثبيتها دون الرجوع للدعم.
        </p>

        <p>للدعم: info@liveservice-sa.com</p>
      `
    );
  } catch {
    return page(
      503,
      "تعذر فتح الهدية حاليًا. حاول مرة أخرى بعد قليل."
    );
  }
};
