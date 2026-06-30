(() => {
// @ts-check
{
    function downloadFile(href) {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = "";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }
    Object.assign(globalThis, { downloadFile });
    if (typeof window !== "undefined") {
        window.downloadFile = downloadFile;
    }
}
})();
