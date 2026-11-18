# Compile one local clip into a CapCut draft

This example creates a five-second vertical draft from a video already included in this repository. It does not download media or use an online service.

From the repository root, run:

```sh
capcut compile examples/local-clip-compile.json
```

The media path in the spec is relative to the spec file, so it works from any clone of this repository. The command places the new draft in CapCut's drafts folder. Open CapCut and look for **Local Clip Example**.

Verified by the contributor: the example draft opens in CapCut 9.8.0.4213 on Windows.
