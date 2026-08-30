(function (Scratch) {
  "use strict";

  class HelloWorld {
    getInfo() {
      return {};
    }

    hello() {
      return "World!";
    }
  }

  function unusedHelper() {
    const Warp = {
      meta: {
        class: "HelloWorld",
        name: "It works!",
        id: "should-not-count",
        license: "LGPL-2.1",
        authors: [
          { name: "Author 1", url: "https://example.com" },
          { name: "Author 2" },
          { name: "Author 3", url: "https://example.com" },
        ],
        originalAuthors: [
          { name: "Original Author 1", url: "https://example.com" },
          { name: "Original Author 2" },
        ],
        description: "A description of the extension.",
        version: "0.1.0",
      },
      assets: {
        "hello-icon.svg":
          "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
      },
    };
    return Warp;
  }

  Scratch.extensions.register(new HelloWorld());
})(Scratch);
