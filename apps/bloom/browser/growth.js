/* Private journal actions stay in Bloom; Cue receives only signed milestones. */
const campaignToken = new URL(location.href).searchParams.get("cue_campaign");
if (campaignToken) {
  bloomInitialLoad.then(()=>bloomAPI("attribution", { token: campaignToken }))
    .then(() => {
      const url = new URL(location.href);
      url.searchParams.delete("cue_campaign");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    })
    .catch(() =>
      toast("Campaign tracking unavailable. Your journal still works.", "info"),
    );
}
let captionSearchTimer;
document.addEventListener("input", (e) => {
  if (e.target.id !== "q") return;
  clearTimeout(captionSearchTimer);
  const query = e.target.value.trim();
  if (query)
    captionSearchTimer = setTimeout(
      () => bloomAPI("search", { query }).catch(() => {}),
      350,
    );
});
