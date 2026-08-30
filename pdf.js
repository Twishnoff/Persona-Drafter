// "Create Persona PDF" — rasterizes the results grid and lays it across as many
// PDF pages as needed. Same approach as Battlecard Generator: html2canvas to
// image, jsPDF to paginate.

(function () {
  const pdfBtn = document.getElementById("pdf-btn");
  const resultsGrid = document.getElementById("results-grid");

  function slugify(str) {
    return String(str || "persona")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  async function exportToPdf() {
    const persona = window.__personaDrafter && window.__personaDrafter.getLastPersona();
    pdfBtn.disabled = true;
    const originalLabel = pdfBtn.textContent;
    pdfBtn.textContent = "Preparing PDF…";

    try {
      const canvas = await html2canvas(resultsGrid, {
        backgroundColor: getComputedStyle(document.body).getPropertyValue("--bg") || "#ffffff",
        scale: Math.min(2, window.devicePixelRatio || 1.5),
        useCORS: true,
      });

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: "pt", format: "letter" });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 28;
      const usableWidth = pageWidth - margin * 2;
      const usableHeight = pageHeight - margin * 2;

      const imgWidth = usableWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      // Title block on page 1.
      const title = persona ? persona.overview?.primary_job_title || "Persona" : "Persona";
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.text(`Persona Draft: ${title}`, margin, margin + 4);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(120);
      pdf.text(
        `Generated ${new Date().toLocaleDateString()} — first draft only, validate with real customer conversations.`,
        margin,
        margin + 18
      );
      pdf.setTextColor(0);

      const contentTop = margin + 32;
      const pageContentHeight = usableHeight - 32;

      // Slice the tall canvas into page-sized chunks.
      let renderedHeight = 0;
      let page = 0;
      while (renderedHeight < imgHeight) {
        if (page > 0) {
          pdf.addPage();
        }
        const sliceHeightPt = Math.min(pageContentHeight, imgHeight - renderedHeight);
        const sliceHeightPx = (sliceHeightPt / imgHeight) * canvas.height;
        const sourceYPx = (renderedHeight / imgHeight) * canvas.height;

        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = sliceHeightPx;
        const ctx = sliceCanvas.getContext("2d");
        ctx.drawImage(canvas, 0, -sourceYPx);

        const sliceData = sliceCanvas.toDataURL("image/png");
        const yOffset = page === 0 ? contentTop : margin;
        pdf.addImage(sliceData, "PNG", margin, yOffset, imgWidth, sliceHeightPt);

        renderedHeight += sliceHeightPt;
        page += 1;
      }

      const filename = `persona-${slugify(title)}-${new Date().toISOString().slice(0, 10)}.pdf`;
      pdf.save(filename);
    } catch (err) {
      console.error("PDF export failed:", err);
      alert("Couldn't generate the PDF — please try again.");
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.textContent = originalLabel;
    }
  }

  pdfBtn.addEventListener("click", exportToPdf);
})();
