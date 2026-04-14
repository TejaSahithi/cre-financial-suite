$migrationsDir = "supabase\migrations"
$files = Get-ChildItem -Path "$migrationsDir\*.sql" | Sort-Object Name

$prefixes = @{}

foreach ($file in $files) {
    $parts = $file.Name.Split('_')
    $prefix = $parts[0]
    
    if ($prefixes.ContainsKey($prefix)) {
        # Increment suffix
        $prefixes[$prefix] += 1
        $count = $prefixes[$prefix]
        $newPrefix = "${prefix}$(Get-Date -Format 'HHmmss')$count"
        $newName = $file.Name.Replace($prefix, $newPrefix)
        Write-Host "Renaming $($file.Name) to $newName"
        Rename-Item -Path $file.FullName -NewName $newName
    } else {
        $prefixes[$prefix] = 1
    }
}
