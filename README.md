# Laverie Maintenance

Application mobile (PWA) de traçabilité pour la maintenance de laveries.

- Plusieurs laveries, et dans chacune ses équipements.
- Interventions, pièces commandées et pièces changées, historique par équipement.
- Un rapport PDF par intervention, avec logo, partageable et archivé dans Google Drive.
- Rappels de maintenance périodique par notification (app ntfy) et par e-mail.
- Fonctionne hors ligne : les données sont gardées sur le téléphone puis synchronisées avec un Google Sheet.

## Organisation du dépôt

| Fichier | Rôle |
| --- | --- |
| `index.html`, `app.js`, `styles.css` | L'application |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation sur le téléphone et mode hors ligne |
| `vendor/` | Bibliothèques de création de PDF (jsPDF) |
| `apps-script/Code.gs` | Script à coller dans le Google Sheet |

## Installation

### 1. Le Google Sheet

1. Avec le compte Google du projet, créer un Google Sheet vide (https://sheets.new) et le nommer « Laverie Maintenance ».
2. Menu **Extensions > Apps Script**. Effacer le contenu affiché et coller tout le fichier [`apps-script/Code.gs`](apps-script/Code.gs). Enregistrer.
3. Dans la liste des fonctions en haut, choisir **installer** puis cliquer sur **Exécuter**. Accepter les autorisations (Google affiche un avertissement « application non validée » : cliquer sur *Paramètres avancés* puis *Accéder au projet*).
   Les onglets Laveries, Equipements, Interventions, Pieces, Maintenances et Config sont créés.
4. Cliquer sur **Déployer > Nouveau déploiement**, type **Application Web**, *Exécuter en tant que* : **Moi**, *Qui a accès* : **Tout le monde**. Cliquer sur **Déployer** et copier l'**URL de l'application Web** (elle finit par `/exec`).
5. Dans l'onglet **Config** du Sheet, copier la valeur de la ligne **jeton**.

L'accès « Tout le monde » est nécessaire pour que le téléphone joigne le script, mais chaque demande est refusée sans le jeton. Ne partagez ni l'URL ni le jeton.

### 2. L'app sur le téléphone

1. Ouvrir l'adresse de l'app dans Chrome sur Android : `https://nicopro88.github.io/laverie-maintenance/`
2. Menu ⋮ de Chrome > **Ajouter à l'écran d'accueil** (ou **Installer l'application**).
3. Dans l'app, onglet **Réglages** : coller l'URL et le jeton, puis **Enregistrer et synchroniser**.
4. Toujours dans les réglages : remplir l'en-tête des rapports PDF et choisir le logo.

### 3. Les notifications

1. Installer l'app gratuite **ntfy** depuis le Play Store.
2. Dans les réglages de l'app Laverie, toucher **Ouvrir dans ntfy** (ou s'abonner à la main au sujet affiché).
3. Toucher **Envoyer un test** pour vérifier.

Les rappels partent chaque matin vers 8 h : 7 jours, 3 jours et 1 jour avant l'échéance, le jour même, puis chaque semaine en cas de retard. Un e-mail récapitulatif est aussi envoyé à l'adresse `emailRappel` de l'onglet Config.

## Mettre à jour le script du Sheet

Si `apps-script/Code.gs` change : recoller le fichier dans Apps Script, puis **Déployer > Gérer les déploiements > ✏️ > Version : Nouvelle version > Déployer**. L'URL reste la même.

## Bon à savoir

- Le point en haut à droite de l'app indique l'état : vert (tout est synchronisé), orange (données en attente d'envoi), rouge (erreur, détail dans les réglages).
- Une ligne corrigée à la main dans le Sheet revient dans l'app à la synchronisation suivante. Pour supprimer, passer par l'app.
- Le logo et l'en-tête des PDF sont gardés sur le téléphone uniquement.
