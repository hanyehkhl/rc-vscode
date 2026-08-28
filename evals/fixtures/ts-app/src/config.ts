export type Config = {
  /** Hide completed tasks from the default listing. */
  hideDone: boolean;
  /** Maximum tasks rendered by `formatList`. */
  pageSize: number;
};

export const defaultConfig: Config = {
  hideDone: false,
  pageSize: 20
};
