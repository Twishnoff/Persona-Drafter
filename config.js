// Public, non-secret config for the static frontend.
// TURNSTILE_SITE_KEY is meant to be public (it's the counterpart to the
// TURNSTILE_SECRET_KEY that lives only in the Worker). Fill both of these in
// after you deploy the Worker — see README.md.
window.PERSONA_DRAFTER_CONFIG = {
  API_BASE_URL: "https://persona-drafter-api.tyler-wishnoff.workers.dev",
  TURNSTILE_SITE_KEY: "0x4AAAAAAEhj_UpeZip62a9o",
};
