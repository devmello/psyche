/** Vite asset URLs (`import url from "./x?url"`), e.g. the PDF.js worker. */
declare module "*?url" {
  const url: string;
  export default url;
}

/** Side-effect CSS imports, including the viewers' lazily loaded Univer stylesheet. */
declare module "*.css";
