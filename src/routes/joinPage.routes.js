import express from "express";
import { asyncHandler } from "../middleware/error.js";
import { joinPageLimiter } from "../middleware/rateLimits.js";
import { findLink, groupSummary } from "../services/joinLink.service.js";
import config from "../config/index.js";

const router = express.Router();

/**
 * GET /join/:code - the page a join link lands on when the app doesn't open it
 * (not installed, a computer, or an in-app browser that ignores App Links).
 * With Chuma installed and links verified, Android opens the app instead and
 * this page is never seen.
 *
 * Deliberately shows no more than search does: the group's name, type, size,
 * contribution and who invited you. Never a phone number.
 */

const TYPE_LABELS = {
  "savings-group": "Savings group",
  cooperative: "Cooperative",
  "womens-group": "Women's group",
  "church-group": "Church group",
  "investment-group": "Investment group",
  chilimba: "Chilimba",
};

const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/** Opens the app through its chuma:// scheme, falling back to the Play Store. */
const openInAppUrl = (code) =>
  `intent://join/${code}#Intent;scheme=chuma;package=com.chuma.zm;S.browser_fallback_url=${encodeURIComponent(
    config.links.playStoreUrl
  )};end`;

function factsLine(summary) {
  const facts = [TYPE_LABELS[summary.groupType] || "Group"];
  facts.push(`${summary.memberCount} member${summary.memberCount === 1 ? "" : "s"}`);
  if (summary.contributionAmount > 0 && summary.contributionFrequency)
    facts.push(
      `K${Number(summary.contributionAmount).toLocaleString("en-US")} ${String(
        summary.contributionFrequency
      ).toLowerCase()}`
    );
  return facts.join(" · ");
}

function page({ title, heading, lead, facts, code, help }) {
  const actions = code
    ? `<a class="btn primary" href="${escapeHtml(openInAppUrl(code))}">Open in Chuma</a>
       <a class="btn" href="${escapeHtml(config.links.playStoreUrl)}">Get Chuma on Google Play</a>`
    : `<a class="btn primary" href="${escapeHtml(config.links.playStoreUrl)}">Get Chuma on Google Play</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(title)} - Chuma</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet" />
  <style>
    :root { --primary:#0A5C36; --bg:#F9FAF9; --surface:#FFFFFF; --text:#1F2937; --heading:#064E3B; --muted:#6B7280; --border:#E5E7EB; --soft:#E6F4ED; --on-primary:#FFFFFF; }
    @media (prefers-color-scheme: dark) {
      :root { --primary:#10B981; --bg:#050A07; --surface:#0C1410; --text:#E5E7EB; --heading:#F9FAF9; --muted:#A3A3A3; --border:#1E3328; --soft:#0F2A20; --on-primary:#03130B; }
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px; background:var(--bg); color:var(--text); font-family:Manrope, system-ui, -apple-system, "Segoe UI", sans-serif; line-height:1.5; }
    main { width:100%; max-width:440px; background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:32px 24px; }
    .brand { font-family:"Plus Jakarta Sans", Manrope, sans-serif; font-weight:800; color:var(--primary); font-size:18px; letter-spacing:-0.3px; margin:0 0 24px; }
    h1 { font-family:"Plus Jakarta Sans", Manrope, sans-serif; color:var(--heading); font-size:24px; line-height:1.25; margin:0 0 12px; letter-spacing:-0.4px; overflow-wrap:anywhere; }
    p { margin:0 0 12px; overflow-wrap:anywhere; }
    .facts { display:inline-block; background:var(--soft); color:var(--heading); border-radius:999px; padding:6px 14px; font-size:13px; font-weight:600; margin:4px 0 20px; }
    .actions { display:flex; flex-direction:column; gap:12px; margin-top:8px; }
    .btn { display:flex; align-items:center; justify-content:center; min-height:56px; border-radius:14px; border:1px solid var(--border); color:var(--heading); font-weight:700; font-size:16px; text-decoration:none; padding:0 16px; text-align:center; }
    .btn.primary { background:var(--primary); border-color:var(--primary); color:var(--on-primary); }
    .help { color:var(--muted); font-size:14px; margin-top:20px; }
  </style>
</head>
<body>
  <main>
    <p class="brand">Chuma</p>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(lead)}</p>
    ${facts ? `<span class="facts">${escapeHtml(facts)}</span>` : ""}
    <div class="actions">${actions}</div>
    ${help ? `<p class="help">${escapeHtml(help)}</p>` : ""}
  </main>
</body>
</html>`;
}

router.get(
  "/:code",
  joinPageLimiter,
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    const link = await findLink(req.params.code);

    if (!link)
      return res.status(404).send(
        page({
          title: "Link not valid",
          heading: "This link isn't valid any more",
          lead: "It may have been replaced, or the invitation was already answered. Ask the group for a new link.",
        })
      );

    const summary = groupSummary(link.group);

    if (link.kind === "expired")
      return res.status(410).send(
        page({
          title: "Link expired",
          heading: "This link has expired",
          lead: `Ask an admin of ${summary.name} to share a new link.`,
        })
      );

    if (link.kind === "invite") {
      const { member } = link;
      const as = member.role && member.role !== "Member" ? ` as ${member.role}` : "";
      return res.send(
        page({
          title: `Join ${summary.name}`,
          heading: `You're invited to ${summary.name}`,
          lead: `${member.invitedByName || "A group admin"} invited you to join ${summary.name}${as} on Chuma.`,
          facts: factsLine(summary),
          code: req.params.code,
          help: "New to Chuma? Install the app and sign up with the number this invitation was sent to. The invitation will be waiting for you.",
        })
      );
    }

    res.send(
      page({
        title: `Join ${summary.name}`,
        heading: `Join ${summary.name} on Chuma`,
        lead: "Open the link in Chuma to ask to join. A group admin approves each request.",
        facts: factsLine(summary),
        code: req.params.code,
        help: "New to Chuma? Install the app, sign up, then come back and tap this link again.",
      })
    );
  })
);

export default router;
