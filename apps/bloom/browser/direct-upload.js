/* Photos go directly to Bloom's Convex project; only small JSON crosses Vercel. */
startUpload = async () => {
  const u = S.upload;
  if (!u) return;
  const file = u.file || S.lastFile?.file;
  if (!file) {
    u.status = "error";
    S.dzMsg = "Choose the photo again.";
    renderDZ();
    return;
  }
  u.status = "uploading";
  u.progress = 0;
  S.dzMsg = "";
  renderDZ();
  updateSave();
  const failed = (message) => {
    u.status = "error";
    S.dzMsg = message || "Couldn't upload your photo. Please try again.";
    S.lastError = {
      name: u.name,
      size: u.size,
      url: u.url,
      at: Date.now(),
      shot: null,
    };
    makeErrorShot(S.lastError);
    renderDZ();
    updateSave();
  };
  try {
    const ticket = await bloomAPI("uploadTicket");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ticket.url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("Authorization", "Bearer " + ticket.token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        u.progress = Math.round((e.loaded / e.total) * 95);
        const bar = $("#upBar"),
          percent = $("#upPct");
        if (bar) bar.style.width = u.progress + "%";
        if (percent) percent.textContent = u.progress + "%";
      }
    };
    xhr.onerror = () => failed();
    xhr.onload = async () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status !== 201)
          throw new Error(data.error || "Photo storage failed");
        const result = await bloomAPI("finishUpload", { fileId: data.fileId });
        if (S.upload !== u) return;
        Object.assign(u, result, { status: "done", progress: 100 });
        renderDZ();
        updateSave();
      } catch (e) {
        failed(e.message);
      }
    };
    xhr.send(file);
  } catch (e) {
    failed(e.message);
  }
};
