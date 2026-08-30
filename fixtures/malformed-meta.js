(function (Scratch) {
  "use strict";

  globalThis.__MALFORMED_SIDE_EFFECT__ = true;

  function getId() {
    return "should-never-run";
  }

  const Warp = {
    meta: {
      class: "HelloWorld",
      name: "It works!",
      id: getId(),
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

  class HelloWorld {
    getInfo() {
      return {
        id: Warp.meta.id,
        name: Warp.meta.name,
        blockIconURI: Warp.assets["hello-icon.svg"],
        blocks: [
          {
            opcode: "hello",
            blockType: Scratch.BlockType.REPORTER,
            text: "Hello!",
          },
        ],
      };
    }

    hello() {
      return "World!";
    }
  }

  Scratch.extensions.register(new HelloWorld());
})(Scratch);
