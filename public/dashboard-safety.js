(() => {
  "use strict";

  const HTML_ENTITIES = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  });

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
  }

  window.DashboardSafety = Object.freeze({ escapeHtml });
})();
