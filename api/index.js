export const config = { runtime: "edge", maxDuration: 30 };

const PREFIX_TO_DOMAIN = {
  "~raw": "raw.githubusercontent.com",
  "~gist": "gist.github.com",
  "~api": "api.github.com",
  "~codeload": "codeload.github.com",
  "~objects": "objects.githubusercontent.com",
  "~avatars": "avatars.githubusercontent.com",
  "~assets": "github.githubassets.com",
  "~assets-cdn": "assets-cdn.github.com",
  "~gist-raw": "gist.githubusercontent.com",
  "~collector": "collector.github.com",
  "~alive": "alive.github.com",
  "~edu": "education.github.com",
  "~lfs": "git-lfs.github.com",
  "~fastly": "github.global.ssl.fastly.net",


  "~security": "securitylab.github.com",
};

const DOMAIN_TO_PREFIX = {};
for (const [prefix, domain] of Object.entries(PREFIX_TO_DOMAIN)) {
  DOMAIN_TO_PREFIX[domain] = prefix;
}
DOMAIN_TO_PREFIX["github.com"] = "";

const REPLACE_DOMAINS = Object.keys(DOMAIN_TO_PREFIX).sort(
  (a, b) => b.length - a.length
);

const SKIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-vercel-id",
  "x-vercel-forwarded-for",
  "x-vercel-deployment-url",
  "x-vercel-ip-city",
  "x-vercel-ip-country",
  "x-vercel-ip-latitude",
  "x-vercel-ip-longitude",
  "x-vercel-ip-timezone",
  "x-real-ip",
]);

const SKIP_RES_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-content-type-options",
]);

const STATIC_PREFIXES = ["~assets", "~avatars", "~fastly", "~assets-cdn"];

function parseTarget(pathname) {
  pathname = pathname
    .replace(
      /(\/[^/]+\/[^/]+\/(?:latest-commit|tree-commit-info)\/[^/]+)\/https?(?:%3A|:)\/\/[^/]+\/.*/,
      "$1"
    );

  const segments = pathname.split("/");
  const first = segments[1] || "";

  if (first.startsWith("~") && PREFIX_TO_DOMAIN[first]) {
    return {
      domain: PREFIX_TO_DOMAIN[first],
      path: "/" + segments.slice(2).join("/"),
      prefix: first,
    };
  }

  return { domain: "github.com", path: pathname, prefix: "" };
}

function rewriteUrls(text, proxyOrigin) {
  const proxyHost = proxyOrigin.replace(/^https?:\/\//, "");

  for (const domain of REPLACE_DOMAINS) {
    const prefix = DOMAIN_TO_PREFIX[domain];
    const proxyBase = prefix ? `${proxyOrigin}/${prefix}` : proxyOrigin;
    const proxyPath = prefix ? `${proxyHost}/${prefix}` : proxyHost;

    text = text.replaceAll(`https://${domain}`, proxyBase);
    text = text.replaceAll(`http://${domain}`, proxyBase);
    text = text.replaceAll(`//${domain}`, `//${proxyPath}`);
  }

  for (const domain of REPLACE_DOMAINS) {
    const prefix = DOMAIN_TO_PREFIX[domain];
    const proxyPath = prefix ? `${proxyHost}/${prefix}` : proxyHost;
    text = text.replaceAll(domain, proxyPath);
  }

  return text;
}

function cleanHtml(html) {
  html = html.replace(
    /<script[^>]*src=["'][^"']*static\.cloudflareinsights\.com[^"']*["'][^>]*><\/script>/gi,
    ""
  );
  html = html.replace(
    /<script[^>]*>[\s\S]*?cloudflareinsights[\s\S]*?<\/script>/gi,
    ""
  );
  return html;
}

function rewriteLocationHeader(location, proxyOrigin) {
  if (!location) return location;
  for (const domain of REPLACE_DOMAINS) {
    const prefix = DOMAIN_TO_PREFIX[domain];
    const proxyBase = prefix ? `${proxyOrigin}/${prefix}` : proxyOrigin;
    location = location.replaceAll(`https://${domain}`, proxyBase);
    location = location.replaceAll(`http://${domain}`, proxyBase);
  }
  return location;
}

function rewriteSetCookie(cookie) {
  return cookie
    .replace(/domain=\.?github\.com/gi, "")
    .replace(/secure;?\s*/gi, "");
}

function isTextContent(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/javascript") ||
    ct.includes("application/x-javascript") ||
    ct.includes("application/xml") ||
    ct.includes("image/svg+xml") ||
    ct.includes("+json") ||
    ct.includes("+xml")
  );
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "*",
        "access-control-max-age": "86400",
      },
    });
  }

  const reqUrl = new URL(req.url);
  const proxyOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
  const { domain, path, prefix } = parseTarget(reqUrl.pathname);
  const targetUrl = `https://${domain}${path}${reqUrl.search}`;

  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (SKIP_REQ_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set("host", domain);
  headers.set("referer", `https://${domain}/`);
  headers.set("origin", `https://${domain}`);

  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html")) {
    headers.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    );
  }

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
    });

    const respHeaders = new Headers();
    respHeaders.set("access-control-allow-origin", "*");
    respHeaders.set("access-control-expose-headers", "*");

    if (STATIC_PREFIXES.includes(prefix)) {
      respHeaders.set("cache-control", "public, max-age=14400, immutable");
    }

    for (const [key, value] of resp.headers.entries()) {
      if (SKIP_RES_HEADERS.has(key.toLowerCase())) continue;

      if (key.toLowerCase() === "location") {
        respHeaders.set(key, rewriteLocationHeader(value, proxyOrigin));
        continue;
      }

      if (key.toLowerCase() === "set-cookie") {
        respHeaders.append(key, rewriteSetCookie(value));
        continue;
      }

      respHeaders.set(key, value);
    }

    const status = resp.status;
    if (status >= 301 && status <= 308) {
      return new Response(null, { status, headers: respHeaders });
    }

    const contentType = resp.headers.get("content-type") || "";

    if (isTextContent(contentType)) {
      let text = await resp.text();
      text = rewriteUrls(text, proxyOrigin);

      if (contentType.includes("text/html")) {
        text = cleanHtml(text);
      }

      return new Response(text, { status, headers: respHeaders });
    }

    return new Response(resp.body, { status, headers: respHeaders });
  } catch (err) {
    return new Response(`Proxy Error: ${err.message}`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
}
