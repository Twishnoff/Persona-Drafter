// Structured output schema for the "finalize_persona" tool.
// Claude calls this tool exactly once, at the end of its research, to hand back
// the data for all six boxes in a shape the frontend can render directly.
// Keep this in sync with frontend/app.js (renderPersona) if you change field names.

// Matches an individual LinkedIn member profile page — linkedin.com/in/<slug>,
// optionally behind a country-code subdomain (uk.linkedin.com/in/..., etc.) and
// optionally with a trailing slash / query / fragment. Deliberately does NOT
// match linkedin.com/jobs/..., linkedin.com/company/..., linkedin.com/pulse/...,
// linkedin.com/posts/..., search-results pages, or any non-LinkedIn domain — the
// prompt asks the model to self-police this, but a job description or company
// page slipping through is exactly the bug this guardrail exists to close.
const LINKEDIN_PROFILE_URL_RE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/?#]+\/?(?:[?#].*)?$/i;

export function isLinkedInProfileUrl(url) {
  return typeof url === "string" && LINKEDIN_PROFILE_URL_RE.test(url.trim());
}

/**
 * Defense-in-depth for the "Sample Profiles" box: the model is told in detail
 * how to find and rank real LinkedIn profiles (see prompt.js), but nothing in
 * the JSON schema itself can enforce "this URL must actually be a member
 * profile page" — an enum/pattern on a free-text URL field isn't practical
 * given how many valid profile slugs exist. This is the code-side backstop:
 * strip any sample_profiles entry whose url isn't a genuine linkedin.com/in/...
 * page (a job posting, company page, article, etc.) before the persona ever
 * reaches the frontend, rather than trusting the model never to submit one.
 * Leaves every other field of the finalize_persona payload untouched.
 */
export function sanitizePersona(persona) {
  if (!persona || typeof persona !== "object") return persona;
  const rawProfiles = Array.isArray(persona.sample_profiles) ? persona.sample_profiles : [];
  const sample_profiles = rawProfiles
    .filter(
      (p) =>
        p &&
        typeof p.job_title === "string" &&
        p.job_title.trim() &&
        typeof p.company === "string" &&
        p.company.trim() &&
        isLinkedInProfileUrl(p.url)
    )
    .slice(0, 5)
    .map((p) => ({ job_title: p.job_title.trim(), company: p.company.trim(), url: p.url.trim() }));

  return { ...persona, sample_profiles };
}

export const FINALIZE_PERSONA_TOOL = {
  name: "finalize_persona",
  description:
    "Submit the completed persona research as structured data for all six result boxes. " +
    "Call this once, after research is complete (or after you've hit your tool-call budget and " +
    "must report partial findings). Omit array entries you couldn't find rather than inventing " +
    "placeholder data — the frontend shows fewer rows instead of fake ones.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["overview", "sample_profiles", "where_they_gather", "org_structure", "work_priorities", "development_priorities"],
    properties: {
      overview: {
        type: "object",
        additionalProperties: false,
        required: [
          "primary_job_title",
          "secondary_job_titles",
          "job_level",
          "avg_years_experience",
          "company_size_label",
          "industry_label",
          "common_tools",
        ],
        properties: {
          primary_job_title: { type: "string", description: "Exactly the job title the user provided." },
          secondary_job_titles: {
            type: "array",
            items: { type: "string" },
            description: "Title variations found in research, e.g. ['Sr. Data Engineer', 'Data Infrastructure Engineer'].",
          },
          job_level: {
            type: "string",
            enum: ["Executive", "Manager", "Individual Contributor"],
          },
          avg_years_experience: {
            type: "string",
            description: "e.g. '5-8 years' — derived from experience ranges seen across evaluated postings.",
          },
          company_size_label: {
            type: "string",
            description: "The size classification used for filtering: 'Enterprise ($1B+ ARR)', 'Midmarket ($50M-$999M ARR)', 'Small Business (<$50M ARR)', or 'No Preference' if none was provided.",
          },
          industry_label: {
            type: "string",
            description: "The matched Crunchbase industry name(s) used for filtering, comma-separated if more than one was treated as a close match. Empty string if industry was not provided or no close match was found.",
          },
          common_tools: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "url"],
              properties: {
                name: { type: "string" },
                url: { type: "string", description: "Vendor's own website for this tool." },
              },
            },
            maxItems: 12,
          },
        },
      },

      sample_profiles: {
        type: "array",
        maxItems: 5,
        description:
          "Up to 5 real LinkedIn member profiles matching this persona. Target 5 — see the Sample " +
          "Profiles rule in the system prompt for the search technique and tiered matching priority. " +
          "Any entry whose url isn't a genuine linkedin.com/in/... profile page is dropped in code " +
          "before the user ever sees it, so never substitute a job posting, company page, or any other " +
          "kind of page for a profile you couldn't find.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["job_title", "company", "url"],
          properties: {
            job_title: { type: "string", description: "Exactly as written on the profile." },
            company: { type: "string" },
            url: {
              type: "string",
              description:
                "Direct LinkedIn member profile URL matching linkedin.com/in/... (a country-code " +
                "subdomain like uk.linkedin.com/in/... is fine). Never a job posting, company page, " +
                "article, or any other kind of URL — see the Sample Profiles rule.",
            },
          },
        },
      },

      where_they_gather: {
        type: "array",
        maxItems: 16,
        description: "Up to 4 each of events, publications/websites/forums, and influencers/blogs relevant to this persona.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "url"],
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["Event", "Publication", "Forum", "Influencer", "Blog"] },
            url: { type: "string" },
          },
        },
      },

      org_structure: {
        type: "object",
        additionalProperties: false,
        required: ["reports_to", "this_role", "manages", "stakeholders"],
        properties: {
          reports_to: { type: "string", description: "Title this role most commonly reports to. Empty string if unclear from research." },
          this_role: { type: "string", description: "The primary job title, restated for the diagram." },
          manages: { type: "string", description: "Short description of who this role manages, if anyone, e.g. '2-4 Growth Marketers'. Empty string if this role is an individual contributor with no reports." },
          stakeholders: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: {
                name: { type: "string", description: "A department/team this role works closely with, e.g. 'Sales', 'Product'." },
                url: { type: "string", description: "Optional link related to that department/function, if one is genuinely relevant." },
              },
            },
            maxItems: 6,
          },
        },
      },

      work_priorities: {
        type: "array",
        maxItems: 10,
        items: { type: "string" },
        description: "The 10 most common, highest-impact responsibilities/initiatives employers expect this role to handle, ranked most- to least-common.",
      },

      development_priorities: {
        type: "array",
        maxItems: 10,
        items: { type: "string" },
        description: "The 10 most common skills/experiences/achievements this role is likely pursuing to progress their own career, ranked most- to least-common.",
      },
    },
  },
};
