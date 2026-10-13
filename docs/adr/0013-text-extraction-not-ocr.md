# Phase 3 证据检索只做文本提取不做 OCR

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

Phase 3 需要真实支持 MD/TXT/DOCX 证据检索。DOCX 可能包含段落、标题、表格、页眉页脚、脚注、链接、批注、修订、图片和嵌入对象。若把所有视觉和嵌入内容都纳入 Phase 3，会引入 OCR、图像理解、版面还原、隐私、成本、延迟和质量评估复杂度。

**Decision**: Phase 3 的文档证据检索索引从 MD/TXT/DOCX 中提取的文本证据，不做 OCR、图片理解、嵌入对象解析或链接爬取。DOCX 表格属于文本证据范围，应以确定性的行/单元格文本序列提取并带 table/row metadata。embedded images/screenshots 只检测并记录 warning，例如 `embedded_image_not_indexed`，不进入检索文本。

解析器必须记录 parser name/version、warnings/errors、表格/图片/链接/脚注等计数，以及 header/footer、comments、track changes 的处理模式。Malformed 文件或无法可靠提取文本的文件不能进入证据检索 active。

**Considered Options**: Phase 3 直接引入 OCR；忽略 DOCX 表格；把 DOCX 当纯文本；爬取 hyperlink；索引批注和修订中的所有隐藏文本。

**Consequences**: Phase 3 范围保持可交付，检索结果只承诺文本证据。用户上传含图片/截图文字的 DOCX 时，系统会明确 warning 未索引这些内容。未来如需 OCR、图片 caption、PDF 或版面级引用，应作为独立功能和评估/ADR 处理。
