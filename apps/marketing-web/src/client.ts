// Kept as a standalone script so the static page needs no framework or runtime service.
export const clientSource = String.raw`"use strict";
const copyButton = document.getElementById("copy-contact");
const copyStatus = document.getElementById("copy-status");
if (copyButton && copyStatus) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("企业智脑 SMEDC\n电话：18514577162\n邮箱：consyinxy@gmail.com");
      copyStatus.textContent = "已复制联系方式，可粘贴到你的通讯工具。";
    } catch {
      copyStatus.textContent = "暂时无法自动复制，请选中上方电话或邮箱手动复制。";
    }
  });
}
`;
