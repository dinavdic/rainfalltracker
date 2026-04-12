declare module "jstat" {
  export const jStat: {
    gamma: {
      cdf(x: number, shape: number, scale: number): number;
      pdf(x: number, shape: number, scale: number): number;
      inv(p: number, shape: number, scale: number): number;
    };
  };
}
