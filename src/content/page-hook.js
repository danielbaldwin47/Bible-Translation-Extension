/*
 * Page-world history hook. Loaded into the page's main world via a
 * web-accessible <script src> (NOT a content script), so it can patch the page's
 * real history object. Patches pushState/replaceState to dispatch
 * 'btx:locationchange', which the content script listens for to detect SPA
 * navigation immediately. Injected as a file (not inline) so it satisfies the
 * site's Content-Security-Policy, which allows scripts from our extension origin.
 */
(function () {
  var patch = function (name) {
    var orig = history[name];
    if (!orig || orig.__btx) return;
    var wrapped = function () {
      var result = orig.apply(this, arguments);
      window.dispatchEvent(new Event('btx:locationchange'));
      return result;
    };
    wrapped.__btx = true;
    history[name] = wrapped;
  };
  patch('pushState');
  patch('replaceState');
})();
