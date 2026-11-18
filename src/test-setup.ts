import { configure } from "@testing-library/react";

// Allow async UI updates to settle on a busy machine and in CI.
configure({ asyncUtilTimeout: 5000 });
