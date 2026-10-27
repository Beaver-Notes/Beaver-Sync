// Serves Apple's Associated Domains (AASA) file for beavernotes.com.
// The website is GitHub Pages, which serves dotfile paths as text/html —
// Apple requires application/json, so this worker answers the routes instead.
// Team/password bundle: F8U6VTU2DJ.com.beavernotes.beaver-notes
const AASA = {
  webcredentials: {
    apps: ["F8U6VTU2DJ.com.beavernotes.beaver-notes"],
  },
};

export default {
  async fetch() {
    return new Response(JSON.stringify(AASA), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      },
    });
  },
};
