declare module 'adm-zip' {
  export default class AdmZip {
    addLocalFolder(path: string): void;
    writeZip(targetPath: string): void;
  }
}
